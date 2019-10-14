import { BehaviorSubject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { CompileModuleError, LoadBundleError, NoDependencyError, PostprocessorError } from './errors';
import {
  CompiledModule,
  IBaseModuleManifest,
  IModuleLoaderEntrypoint,
  ModuleDependencies,
  ModuleLoadStrategy,
  ModuleUrlFormatter
} from './interface';
import { ManifestProcessors } from './manifest-processors';

const InvalidHttpStatusStart = 400;

function fetchBundleSource(url: string): Promise<string> {
  return fetch(url).then((response: Response) => {
    if (response.status >= InvalidHttpStatusStart) {
      throw new LoadBundleError(`Cant load bundle, http error ${response.status}`);
    }

    return response.text();
  });
}

function compileSource(
  source: string,
  dependencies: ModuleDependencies,
  unknownResolver: (name: string) => object | undefined
): CompiledModule {
  // @ts-ignore
  // tslint:disable-next-line
  const require = (name: string): any => {
    let dependency = dependencies[name];
    if (!dependency) {
      if (unknownResolver) {
        const unknownDependency = unknownResolver(name);
        if (!unknownDependency) {
          // В любом случае кинуть ошибку. Может быть конечно, что микросервис просит зависимость,
          // но не использует её и скомпилируется, однако лучше явно сообщить и по результатам:
          // а) Выпилить зависимость из микросервиса
          // б) Внести зависимость в ядро
          // в) Вкомпилировать зависимость в микросервис
          throw new NoDependencyError(`Dependency "${name}" does not provided by core application`);
        }
        dependency = unknownDependency;
      }
    }

    return dependency;
  };
  // TODO поставить сеттеры, чтобы понимать, куда компилированный модуль положил данные - чистый там UMD или вебпак
  const exports = {};
  const module = {
    exports: {}
  };
  try {
    // tslint:disable-next-line
    eval(source);
  } catch (ex) {
    throw new CompileModuleError(`Cant compile module: ${ex.message}`);
  }

  return module as CompiledModule;
}

export class ModuleLoaderTool<TModuleManifest extends IBaseModuleManifest> {
  private dependencies: ModuleDependencies = {};
  private unknownDependencyResolver: (name: string) => object | undefined;
  private urlFormatter: ModuleUrlFormatter<TModuleManifest>;
  private entrypoint: IModuleLoaderEntrypoint<TModuleManifest>;

  private manifestProcessors: ManifestProcessors<TModuleManifest> = new ManifestProcessors();
  private bundlesList: Array<TModuleManifest>;
  // @ts-ignore TS считает, что пустой массив низя приводить к массиву элементов
  private bundlesListStream$: BehaviorSubject<Array<TModuleManifest>> = new BehaviorSubject([]);
  private bundlesCache: Record<string, CompiledModule> = {};
  private loadersCache: Record<string, Promise<CompiledModule | void>> = {};

  private startupCheck(): void {
    if (!this.urlFormatter) {
      throw new Error('urlFormatter is not defined');
    }

    if (!this.entrypoint) {
      throw new Error('entrypoint is not defined');
    }
  }

  private bulkLoadBundles(filterFn: (manifest: TModuleManifest) => boolean): Promise<void> {
    return Promise.all(
      this.bundlesList.filter(filterFn).map((manifest: TModuleManifest) => this.loadBundleByManifest(manifest))
    ).then((compiledBundles: Array<CompiledModule | void>) => {
      compiledBundles.forEach((compiledBundle: CompiledModule | void) => {
        const exports = compiledBundle && compiledBundle.exports;
        if (exports && exports.start) {
          exports.start();
        }
      });
    });
  }

  private setBundlesList(list: Array<TModuleManifest>): void {
    this.bundlesList = list;
    this.bundlesListStream$.next(list);
  }

  defineDependencies(dependencies: ModuleDependencies): void {
    this.dependencies = dependencies;
  }

  defineUnknownDependencyResolver(resolver: (name: string) => object | undefined): void {
    this.unknownDependencyResolver = resolver;
  }

  defineUrlFormatter(formatter: ModuleUrlFormatter<TModuleManifest>): void {
    this.urlFormatter = formatter;
  }

  defineEntrypoint(entrypoint: IModuleLoaderEntrypoint<TModuleManifest>): void {
    this.entrypoint = entrypoint;
  }

  /**
   * Метод регистрирует препроцессор вашего модуля. Препроцессоров может быть много.
   * В препроцессоре можно исполнить какую-нибудь логику до загрузки сервиса или принять решение его не загружать.
   * Пример использования - начать параллельную загрузку css, который нужен модулю.
   * Препроцессор может предотвратить загрузку сервиса вернув Promise.reject()
   * Все препроцессоры будут запущены по очереди, синхронные будут обернуты в промисы и все это завернется в Promise.all
   * После отработки всех препроцессоров, если итоговый промис не будет реджектнут - начнется загрузка сервиса
   * Есть какой-то промис реджектнется - будет сообщение в консоли
   * @param typeMatcher
   * @param processor
   * @param modulePostprocessor
   */
  definePreprocessor(
    typeMatcher: (manifest: TModuleManifest) => boolean,
    processor: (manifest: TModuleManifest) => void | Promise<void>
  ): void {
    this.manifestProcessors.registerPreprocessor(typeMatcher, processor);
  }

  /**
   * Метод регистрирует пострпроцессор для обработки загруженного модуля. Постпроцессоров может быть много.
   * В постпроцессоре можно вызвать что-нибудь из экспортов вашего модуля, можно что-нибудь оттуда достать.
   * Постпроцессор может быть синхронным(не возвращает ничего) и может быть асинхронным(возвращает промис)
   * Все постпроцессоры будут запущены по очереди, синхронные будут обернуты в промисы и все это завернется в
   * Promise.all
   * После отработки всех постпроцессоров поток управления возвращается mlt, который передает управление вам и
   * возвращает CompiledModule
   * @param typeMatcher - функция-матчер, на вход получит ваш манифест, на выход даст boolean, запускать
   * постпроцессор или нет
   * @param processor - процессор вашего модуля после его загрузки. Вы получаете доступ к экспортам этого модуля
   */
  definePostprocessor(
    typeMatcher: (manifest: TModuleManifest) => boolean,
    processor: (manifest: TModuleManifest, module: CompiledModule) => void | Promise<void>
  ): void {
    this.manifestProcessors.registerPostprocessor(typeMatcher, processor);
  }

  /**
   * Хэлпер на проверку, что бандл уже загружен. Полезен для интерфейсных решений загрузки
   * @param bundleName - имя бандла на проверку
   */
  isBundleLoaded(bundleName: string): boolean {
    return !!this.bundlesCache[bundleName];
  }

  /**
   * Метод старта mlt
   * @param filterFn - функция по фильтрации бандлов по какому-то признаку, которые не будут положены в bundlesList
   * Здесь можно исключить какие-то бандлы или наоборот - загрузить только нужные
   */
  init(filterFn?: (m: TModuleManifest) => boolean): Promise<void> {
    this.startupCheck();

    return fetch(this.entrypoint.manifestUrl)
      .then((response: Response) => response.text())
      .then((bundlesText: string) => JSON.parse(bundlesText))
      .then(
        // tslint:disable-next-line
        (bundlesObj: any) => {
          const flattener = this.entrypoint.flattener;
          const loadedBundles = flattener ? flattener(bundlesObj) : bundlesObj;

          if (!filterFn) {
            this.setBundlesList(loadedBundles);

            return;
          }

          this.setBundlesList(loadedBundles.filter(filterFn));
        }
      )
      .then(() =>
        this.bulkLoadBundles((manifest: TModuleManifest) => manifest.loadStrategy === ModuleLoadStrategy.BLOCK)
      );
  }

  /**
   * Метод нужен для того, чтобы соблюсти очередность и запустить сперва приложение, а потом начать загрузку всех
   * микросервисов, которые "немедленно", но не "блокирующие"
   * @param runner - функция старта приложения
   */
  // tslint:disable-next-line
  start(runner: (...args: Array<any>) => any): Promise<void> {
    // Run and load immediately services in parallel
    return Promise.resolve()
      .then(() => runner())
      .then(() =>
        this.bulkLoadBundles((manifest: TModuleManifest) => manifest.loadStrategy === ModuleLoadStrategy.IMMEDIATELY)
      );
  }

  /**
   * Метод загрузки бандла по манифесту - здесь есть вся инфа для загрузки и содержится логика загрузки,
   * кеширования, обработки и вовзрата загруженного модуля
   * @param manifest - манифест модуля
   */
  private loadBundleByManifest(manifest: TModuleManifest): Promise<CompiledModule | void> {
    if (this.bundlesCache[manifest.name]) {
      return Promise.resolve(this.bundlesCache[manifest.name]);
    }

    if (this.loadersCache[manifest.name]) {
      return this.loadersCache[manifest.name];
    }

    const serviceFileUrl = this.urlFormatter(manifest);

    this.loadersCache[manifest.name] = this.manifestProcessors
      .runPreprocessors(manifest)
      .then(() => fetchBundleSource(serviceFileUrl))
      .then((source: string) => compileSource(source, this.dependencies, this.unknownDependencyResolver))
      .then((compiledModule: CompiledModule) => {
        this.bundlesCache[manifest.name] = compiledModule;

        return this.manifestProcessors
          .runPostprocessors(manifest, compiledModule)
          .then(() => compiledModule)
          .catch(() => {
            throw new PostprocessorError('Postprocessor crashed');
          });
      })
      .catch((error: NoDependencyError | CompileModuleError | PostprocessorError) => {
        console.error(`Module: ${manifest.name}. Error: ${error.message}`);

        return void 0;
      });

    return this.loadersCache[manifest.name];
  }

  /**
   * Метод загрузки модуля.
   * Редко используется вручную, но часто используется из хэлперов типа LazyComponent
   * Принимает именно имя модуля, а не манифест - чтоб не усложнять клиентский код перекидываниями манифестами
   * @param name - имя модуля
   */
  loadBundleByName(name: string): Promise<CompiledModule | void> {
    const manifest = this.bundlesList.find((m: TModuleManifest) => m.name === name);
    if (!manifest) {
      throw new Error(`Module with name "${name}" is not declared`);
    }

    return this.loadBundleByManifest(manifest);
  }

  /**
   * Синхронный способ отфильтровать нужные бандлы без прямого доступа к бандлам
   * @param fn - фильтрующая функция
   */
  filter(fn: (bundle: TModuleManifest) => boolean): Array<TModuleManifest> {
    return this.bundlesList.filter(fn);
  }

  /**
   * Потоковый способ отфильтровать нужные бандлы и получать их в процессе изменения(нужно при разработке)
   *
   * @param fn - фильрующая функция
   */
  subscribe(fn?: (bundle: TModuleManifest) => boolean): Observable<Array<TModuleManifest>> {
    const filterFn = (bundle: TModuleManifest): boolean => {
      return fn ? fn(bundle) : true;
    };

    return this.bundlesListStream$.pipe(
      map((bundles: Array<TModuleManifest>): Array<TModuleManifest> => bundles.filter(filterFn))
    );
  }

  /**
   * Определение бандла вручную для локальной разработки
   * @param manifest - объект, точно повторяющий ваш манифест
   * @param bundle - объект с полем exports
   */
  manuallyDefineBundle(manifest: TModuleManifest, bundle: CompiledModule): void {
    this.bundlesList.push(manifest);
    this.setBundlesList(this.bundlesList);
    if (bundle.exports.start) {
      bundle.exports.start();
    }

    if (this.bundlesCache[manifest.name]) {
      throw new Error(`Manifest with name "${manifest.name}" already defined, break;`);
    }
    this.bundlesCache[manifest.name] = bundle;
  }
}