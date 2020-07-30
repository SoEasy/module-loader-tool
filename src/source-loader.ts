import { MLTConfig } from './config';
import {
  ErrorTypes,
  TBaseModuleManifest,
  TFormatUrlFn,
  TLoadSourceFn,
  TSourceLoadingResult,
  TSourceMonad
} from './types';
import { LoadSourceFnError } from './utils';

const BAD_REQUEST_INVALID_URL_STATUS = 400;
const INTERNET_CONNECTION_LOST_STATUS = -1;

const defaultLoadSourceFn: TLoadSourceFn = (url: string): Promise<string> => {
  return fetch(url)
    .catch(() => {
      throw new LoadSourceFnError('Internet Connection is lost', INTERNET_CONNECTION_LOST_STATUS);
    })
    .then((response: Response) => {
      if (!response.ok) {
        throw new LoadSourceFnError(`Cant load bundle, http error ${response.status}`, response.status);
      }

      return response.text();
    });
};

export class MLTSourceLoader<TUserManifest extends TBaseModuleManifest> {
  private get loadSourceFn(): TLoadSourceFn {
    return this.config.configObj.loadSourceFn || defaultLoadSourceFn;
  }

  private get formatUrlFn(): TFormatUrlFn<TUserManifest> {
    return this.config.configObj.urlFormatter;
  }

  private notLoadedManifests: Array<string> = [];

  // tslint:disable-next-line:no-any
  constructor(private config: MLTConfig<any>) {}

  loadSource = (manifest: TUserManifest): Promise<TSourceLoadingResult<TUserManifest>> => {
    if (!this.formatUrlFn) {
      throw new Error('No formatUrlFn function provided in mlt.loader');
    }

    if (this.notLoadedManifests.includes(manifest.name)) {
      console.error('Retry load source, but already known that url invalid', manifest);

      return Promise.resolve({
        sourceLoadingError: void 0,
        sourceMonad: {
          manifest,
          source: void 0
        }
      });
    }

    const url = this.formatUrlFn(manifest);

    return this.loadSourceFn(url)
      .catch((error: LoadSourceFnError) => {
        console.error('Cant load source for manifest', manifest);
        console.error('Error: ', error);
        if (error.status === BAD_REQUEST_INVALID_URL_STATUS) {
          this.notLoadedManifests.push(manifest.name);
        }

        return error;
      })
      .then((moduleSourceOrError: string | LoadSourceFnError) => {
        const error =
          moduleSourceOrError instanceof LoadSourceFnError
            ? {
                error: moduleSourceOrError,
                type:
                  moduleSourceOrError.status === INTERNET_CONNECTION_LOST_STATUS
                    ? ErrorTypes.INTERNET_CONNECTION_ERROR
                    : ErrorTypes.MODULE_LOADING_ERROR
              }
            : void 0;

        return this.config.processorsManager
          .runSourcePreprocessors({
            manifest,
            source: moduleSourceOrError instanceof LoadSourceFnError ? void 0 : moduleSourceOrError
          })
          .then((sourceMonad: TSourceMonad<TUserManifest>) => ({
            sourceLoadingError: error,
            sourceMonad
          }));
      });
  };
}
