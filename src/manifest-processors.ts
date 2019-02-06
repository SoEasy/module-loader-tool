import { CompiledModule, IBaseModuleManifest, ModulePostprocessor, ModulePreprocessor, TypeMatcher } from './interface';

export class ManifestProcessors<TModuleManifest extends IBaseModuleManifest> {
  private typeMatchers: Record<string, TypeMatcher<TModuleManifest>> = {};
  private modulePreprocessors: Record<string, ModulePreprocessor<TModuleManifest>> = {};
  private modulePostprocessors: Record<string, ModulePostprocessor<TModuleManifest>> = {};

  private getModuleTypeByManifest(manifest: TModuleManifest): string | void {
    for (const typeKey of Object.keys(this.typeMatchers)) {
      const typeMatcher = this.typeMatchers[typeKey];
      if (typeMatcher(manifest)) {
        return typeKey;
      }
    }
    console.warn(`Cant resolve type of service "${manifest.name}"`);

    return;
  }

  registerManifestType(
    type: string,
    typeMatcher: TypeMatcher<TModuleManifest>,
    modulePreprocessor?: ModulePreprocessor<TModuleManifest>,
    modulePostprocessor?: ModulePostprocessor<TModuleManifest>
  ): void {
    this.typeMatchers[type] = typeMatcher;
    if (modulePreprocessor) {
      this.modulePreprocessors[type] = modulePreprocessor;
    }
    if (modulePostprocessor) {
      this.modulePostprocessors[type] = modulePostprocessor;
    }
  }

  runPreprocessor(manifest: TModuleManifest): Promise<void> {
    const moduleType = this.getModuleTypeByManifest(manifest);
    if (!moduleType) {
      return Promise.resolve();
    }

    return this.modulePreprocessors[moduleType] ? this.modulePreprocessors[moduleType](manifest) : Promise.resolve();
  }

  runPostprocessor(manifest: TModuleManifest, module: CompiledModule): Promise<void> {
    const moduleType = this.getModuleTypeByManifest(manifest);
    if (!moduleType) {
      return Promise.resolve();
    }

    return this.modulePostprocessors[moduleType]
      ? this.modulePostprocessors[moduleType](manifest, module)
      : Promise.resolve();
  }
}
