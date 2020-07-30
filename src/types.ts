import { LoadSourceFnError } from './utils';

/**
 * Стратегии загрузки модулей
 */
export enum ModuleLoadStrategy {
  /**
   * Блокирующая стратегия. Не будет дан старт приложению до тех пор,
   * пока не загрузятся все блокирующие модули
   */
  BLOCK = 'block',

  /**
   * Неблокирующая стратегия, модули начнут загружаться после того, как будет дан старт приложению
   */
  IMMEDIATELY = 'immediately',

  /**
   * Стратегия загрузки сервисов по запросу, автоматически не грузятся
   */
  ON_DEMAND = 'on_demand',

  /**
   * Стартегия загрузки сервисов лениво, по доступности.
   * Доступность командуется извне, например из сервис-воркера если например пять секунд не было запросов сети
   */
  LAZY = 'lazy'
}

/**
 * Тип ошибки при работе с модулем
 */
export enum ErrorTypes {
  INTERNET_CONNECTION_ERROR = 'internet-connection-error',
  MODULE_LOADING_ERROR = 'module-loading-error',
  MODULE_COMPILE_ERROR = 'module-compile-error'
}

/**
 * Тип подмодуля
 */
export enum ModuleSearchType {
  /**
   * Или корневой модуль, или дочерний модуль - они равны перед системой
   * У модуля может быть функция start, может быть getComponentFn
   */
  MODULE = 'module',

  /**
   * Ребенок, вкомпилирован в сам модуль. Ребенок - это просто функция, с какой-то метаинформацией в манифесте
   */
  CHILD = 'child'
}

/**
 * Ручной запуск в фоне каких-то процессов из какого-то микросервиса. А-ля префеч в готовящемся реакте.
 * Это объект вида { service: string, fn: string }
 * service - это имя микросервиса/модуля. Т.е. допустимы значения типа 'sandbox' или 'sandbox.bootstrap', 'sanbox.ui'
 * fn - имя функции.
 *
 * Если сервис/модуль будет найден - он попытается загрузиться, из его экспортов
 * попытается вызваться переданная функция. Без возврата, без ожидания - просто запустится в молоко
 *
 * На самом деле под капотом этот объект превращатеся в строку для следования пути MLT.
 *
 * Кейс использования prefetch
 * Например есть какой-то микросервис, у которого есть бутстрап и несколько других модулей.
 * Всем им нужны какие-то данные, которые управляются вкомпилированным в bootstrap кодом.
 * Бутстрап например делает одно единственное действие - садится на шину и что-то слушает.
 * НО! Например мы идем на страницу сервиса - пока она загрузится, пока скомпилируется - это все время.
 * И после загрузки этой страницы она погонит делать инициирующий запрос на сервер. Кодом, который в бутстрапе.
 * Ну, данные клиента получить например. И пусть эта страница живет в модуле sandbox.page_one
 * Зачем нам ждать, пока загрузится и скомплируется целая страница перед тем, как делать запрос? Пусть его сделает
 * бутстрап. Но не сам, а по явному указанию.
 * В манифесте мы можем указать "пока грузится эта страница - запусти запрос на сервер в
 * sandbox.bootstrap.prefetchUserData".
 * А после загрузки страницы, если вы в бутстрапе сделали все по красоте - вы дернете из бутстрапа эту же функцию,
 * а она вернет вам уже закешированный запущенный(и возможно разрешенный) промис с данными.
 *
 * modules: {
 *   bootstrap: { type: 'service', loadStrategy: 'block' },
 *   page_one: {
 *     type: 'modal_route',
 *     loadStrategy: 'lazy',
 *     route: '/page1',
 *     prefetchFn: { service: 'sandbox.bootstrap', fn: 'prefetchUserData' }
 *   }
 * }
 *
 * Рекомендация - использовать prefetch только для вызова функций из уже загруженных модулей типа block. В остальных
 * слуаях prefetch будет вынужден загрузить и скомпилировать модуль.
 * Важно - если модуль будет загружен и скомпилирован - у него будет вызван start(если есть) - исключений тут быть не
 * может, имейте ввиду
 */
export type TPrefetchConfig = {
  serviceName: string;
  fn: string;
};

/**
 * Базовые поля, необходимые каждому манифесту
 */
export type TBaseModuleManifest<TUserAddition = {}, TChild = {}> = {
  /**
   * Required. microservice name - root for searching, loading, compiling and many more
   */
  name: string;

  /**
   * Required. Is microservice enabled?
   */
  enabled: boolean;

  /**
   * Required. Choose load strategy
   */
  loadStrategy: ModuleLoadStrategy;

  /**
   * Required. Name of JS file to load and compile
   */
  fileName: string;

  /**
   * Optional. Just a good practice to annotate which childrens available from microservice
   */
  childs?: Array<TChild>;

  /**
   * Optional, but important - which submodules produced by that microservice
   */
  modules?: Record<string, TBaseModuleManifest<TUserAddition>>;

  /**
   * What should be loaded and executed in parallel with loading-compiling-running module.
   *
   */
  prefetchFn?: TPrefetchConfig;

  /**
   * Предзагружаемые модули. Когда мы знаем, что нам в процессе использования сервиса понадобятся другие модули -
   * MLT их предзагрузит. Но не скомпилирует. Или скомпилирует?
   * Я размышляю с двух позиций предзагрузки:
   * предзагрузка lazy чтоб сэкономить лаг сети
   * предзагрузка того, что стопудово заиспользуется
   * Ядро в акварели не предзагружает lazy. Значит если в акварели используется preloadModules - их по хорошему
   * стоит скомпилировать. Сеть уже нагрузили, предкомпилция снизит лаг
   * А еще в пользу компиляции говорит следующий пропс - blockModules. Без запуска этих модулей неовзможен старт
   * данного.
   */
  preloadModules?: Array<string>;

  /**
   * Модули, без которых невозможна работа данного модуля.
   * Эти модули необходимо загрузить, скомпилировать, запустить в них start, и только после этого отдать управление
   * компиляции целевого модуля.
   * Если зависимые модули не загрузились или не скомпилировались - finita la comedia, модуль перейдет в стадию ошибки.
   *
   * Ох сука, если кто-то сделает тут циклическую зависимость - будет весело, вся полторашка нагнется. Ну, мб не
   * нагнется, но ей точно будет нехорошо. И в конце концов, я просто напишу резолвер циклических зависимостей
   */
  blockModules?: Array<string>;
} & TUserAddition;

export type TManifestFlattener<T extends TBaseModuleManifest = never> = (manifestObject: object) => Array<T>;

export type TModuleDependencies = Record<string, object>;

export type TUnknownDependencyResolver = (dependencyName: string, manifest?: TBaseModuleManifest) => object | void;

export type TFormatUrlFn<TUserManifest extends TBaseModuleManifest> = (module: TUserManifest) => string;

export type TLoadSourceFn = (url: string) => Promise<string>;

// tslint:disable-next-line:no-any
export type TCompileFn<U, T = {}> = (sourceMonad: TSourceMonad<U>, ...args: Array<any>) => Promise<TCompiledModule<T>>;

export type TSearchModuleResult<T extends TBaseModuleManifest = never> =
  | ({ manifest: T } & ({ type: ModuleSearchType.MODULE } | { type: ModuleSearchType.CHILD; childName: string }))
  | void;

export type TCompiledModule<T = {}> = {
  exports: {
    start?: () => void;
    getModuleDependencies?: () => object;
    getUnknownResolver?: () => TUnknownDependencyResolver;
    // tslint:disable-next-line:no-any
    [key: string]: any;
  } & T;
};

// Не совсем трушные монады, но внутри системы и исходники, и скомпилированные объекты передаются
// в паре со своими манифестами

export type TSourceMonad<TUserManifest> = {
  manifest: TUserManifest;
  source: string | void;
};

export type TCompiledMonad<TUserManifest, TModule extends TCompiledModule = TCompiledModule> = {
  manifest: TUserManifest;
  module: TModule | void;
};

type TProcessorResult = Promise<void> | Promise<never> | void;
export type TTypeMatcher<T extends TBaseModuleManifest> = (manifest: T) => boolean;
export type TTypeMatcherWithSource<T extends TBaseModuleManifest> = (sourceMonad: TSourceMonad<T>) => boolean;
export type TModulePreprocessor<T extends TBaseModuleManifest> = (manifest: T) => TProcessorResult;
export type TSourcePreprocessor<T extends TBaseModuleManifest> = (
  sourceMonad: TSourceMonad<T>
) => Promise<TSourceMonad<T>>;
export type TModulePostprocessor<T extends TBaseModuleManifest> = (
  compiledMonad: TCompiledMonad<T>
) => TProcessorResult;

export type TMltConfig<TUserManifest extends TBaseModuleManifest> = {
  dependencies: TModuleDependencies;
  unknownDependencyResolver?: TUnknownDependencyResolver;

  rootManifestUrl: string;
  manifestFlattener: TManifestFlattener<TUserManifest>;

  urlFormatter: TFormatUrlFn<TUserManifest>;
  loadSourceFn?: TLoadSourceFn;

  compileFn?: TCompileFn<TUserManifest>;

  /**
   * Limit how much bundles should be loaded by lazyLoader when system in IDLE. Default - 2
   */
  lazyLoaderLimit?: number;
};

export type TMLTProcessError = {
  type: ErrorTypes;
  error: Error | LoadSourceFnError;
};

export type TSourceLoadingResult<T> = {
  sourceLoadingError: TMLTProcessError | void;
  sourceMonad: TSourceMonad<T>;
};

export type TSourceCompilingResult<T> = {
  sourceCompilingError: TMLTProcessError | void;
  compiledMonad: T;
};
