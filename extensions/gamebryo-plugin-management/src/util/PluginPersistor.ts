import {ILoadOrder} from '../types/ILoadOrder';
import {nativePlugins, pluginFormat, pluginPath} from '../util/gameSupport';

import * as Promise from 'bluebird';
import * as fs from 'fs-extra-promise';
import {decode, encode} from 'iconv-lite';
import {log, types, util} from 'nmm-api';
import * as path from 'path';

export type PluginFormat = 'original' | 'fallout4';

interface IPluginMap {
  [name: string]: ILoadOrder;
}

const retryCount = 3;

/**
 * persistor syncing to and from the gamebryo plugins.txt and loadorder.txt
 *
 * @class PluginPersistor
 * @implements {types.IPersistor}
 */
class PluginPersistor implements types.IPersistor {
  private mPluginPath: string;
  private mPluginFormat: PluginFormat;
  private mNativePlugins: Set<string>;
  private mResetCallback: () => void;

  private mWatch: fs.FSWatcher;
  private mRefreshTimer: NodeJS.Timer;
  private mSerializing: boolean = false;
  private mSerializeQueue: Promise<void> = Promise.resolve();

  private mPlugins: IPluginMap;
  private mRetryCounter: number = retryCount;
  private mLoaded: boolean = false;
  private mFailed: boolean = false;
  private mOnError: (message: string, details: Error) =>  void;

  constructor(onError: (message: string, details: Error) => void) {
    this.mPlugins = {};
    this.mOnError = onError;
  }

  public disable() {
    this.mPlugins = {};
    this.mLoaded = true;
    if (this.mResetCallback) {
      this.mResetCallback();
      this.mRetryCounter = retryCount;
    }
  }

  public loadFiles(gameMode: string) {
    this.mPluginPath = pluginPath(gameMode);
    this.mPluginFormat = pluginFormat(gameMode);
    this.mNativePlugins = new Set(nativePlugins(gameMode));
    log('debug', 'synching plugins', { pluginsPath: this.mPluginPath });
    // read the files now and update the store
    this.deserialize();
    // start watching for external changes
    this.startWatch();
  }

  /**
   * immediately stops all syncing with the files on disc
   * This should be used to prevent file corruption when switching
   * game mode
   */
  public stopSync() {
    this.mPluginPath = undefined;
    this.mPluginFormat = undefined;
    this.mNativePlugins = undefined;

    if (this.mWatch !== undefined) {
      this.mWatch.close();
      this.mWatch = undefined;
    }
  }

  public setResetCallback(cb: () => void) {
    this.mResetCallback = cb;
  }

  public getItem(key: string, cb?: (error: Error, result?: string) => void): Promise<any> {
    const res = JSON.stringify(this.mPlugins);
    if (cb) {
      cb(null, res);
    }
    return Promise.resolve(res);
  }

  public setItem(key: string, value: string, cb?: (error: Error) => void): Promise<void> {
    this.mPlugins = JSON.parse(value);
    return this.serialize().then(() => cb && cb(null));
  }

  public removeItem(key: string, cb?: (error: Error) => void): Promise<void> {
    delete this.mPlugins[key];
    return this.serialize().then(() => cb && cb(null));
  }

  public getAllKeys(cb?: (error: Error, keys?: string[]) => void): Promise<void> {
    if (cb) {
      cb(null, ['loadOrder']);
    }
    return Promise.resolve();
  }

  private reportError(message: string, detail: Error) {
    if (!this.mFailed) {
      this.mOnError(message, detail);
      this.mFailed = true;
    }
  }

  private toPluginList(input: string[]) {
    if (this.mPluginFormat === 'original') {
      return this.toPluginListOriginal(input);
    } else {
      return this.toPluginListFallout4(input);
    }
  }

  private toPluginListOriginal(input: string[]) {
    return input.filter(
        (pluginName: string) => this.mPlugins[pluginName].enabled);
  }

  private toPluginListFallout4(input: string[]) {
    return input.map((name: string) => {
      if (util.getSafe(this.mPlugins, [name, 'enabled'], false)) {
        return '*' + name;
      } else {
        return name;
      }
    });
  }

  private serialize(): Promise<void> {
    if (!this.mLoaded) {
      // this happens during initialization, when the persistor is initially created
      return Promise.resolve();
    }
    // ensure we don't try to concurrently write the files
    return this.mSerializeQueue =
               this.mSerializeQueue.then(() => this.doSerialize());
  }

  private doSerialize(): Promise<void> {
    if (this.mPluginPath === undefined) {
      return;
    }

    this.mSerializing = true;

    const sorted: string[] =
        Object.keys(this.mPlugins)
            .filter((pluginName: string) =>
                        !this.mNativePlugins.has(pluginName.toLowerCase()))
            .sort((lhs: string, rhs: string) => this.mPlugins[lhs].loadOrder -
                                                this.mPlugins[rhs].loadOrder);

    return fs.writeFileAsync(path.join(this.mPluginPath, 'loadorder.txt'),
      encode('# Automatically generated by Vortex\r\n' + sorted.join('\r\n'), 'utf-8'))
      .then(() => {
        const filtered: string[] = this.toPluginList(sorted);
        return fs.writeFileAsync(path.join(this.mPluginPath, 'plugins.txt'),
          encode('# Automatically generated by Vortex\r\n' + filtered.join('\r\n'), 'latin-1'));
      })
      .then(() => { this.mFailed = false; })
      .catch(err => {
        this.reportError('failed to write plugin list', err);
      })
      .finally(() => {
        this.mSerializing = false;
      })
      ;
  }

  private filterFileData(input: string, plugins: boolean): string[] {
    const res = input.split(/\r?\n/).filter((value: string) => {
        return !value.startsWith('#') && (value.length > 0);
      });

    return res;
  }

  private initFromKeyList(plugins: IPluginMap, keys: string[], enabled: boolean) {
    let loadOrderPos = Object.keys(plugins).length;
    keys.forEach((key: string) => {
      const keyEnabled = enabled && ((this.mPluginFormat === 'original') || (key[0] === '*'));
      if ((this.mPluginFormat === 'fallout4') && (key[0] === '*')) {
        key = key.slice(1);
      }
      // ignore "native" plugins
      if (this.mNativePlugins.has(key.toLowerCase())) {
        return;
      }
      if (plugins[key] !== undefined) {
        plugins[key].enabled = keyEnabled;
      } else {
        plugins[key] = {
          enabled: keyEnabled,
          loadOrder: loadOrderPos++,
        };
      }
    });
  }

  private deserialize(retry: boolean = false): Promise<void> {
    if (this.mPluginPath === undefined) {
      return;
    }

    const newPlugins: IPluginMap = {};

    let phaseOne: Promise<NodeBuffer>;
    if (this.mPluginFormat === 'original') {
      phaseOne = fs.readFileAsync(path.join(this.mPluginPath, 'loadorder.txt'))
        .then((data: NodeBuffer) => {
          const keys: string[] =
            this.filterFileData(decode(data, 'utf-8'), false);
          this.initFromKeyList(newPlugins, keys, false);
          return fs.readFileAsync(
            path.join(this.mPluginPath, 'plugins.txt'));
        });
    } else {
      phaseOne = fs.readFileAsync(path.join(this.mPluginPath, 'plugins.txt'));
    }
    return phaseOne
    .then((data: NodeBuffer) => {
      if ((data.length === 0) && !retry) {
        // not even a header? I don't trust this
        // TODO: This is just a workaround
        return this.deserialize(true);
      }
      const keys: string[] = this.filterFileData(decode(data, 'latin-1'), true);
      this.initFromKeyList(newPlugins, keys, true);
      this.mPlugins = newPlugins;
      this.mLoaded = true;
      if (this.mResetCallback) {
        this.mResetCallback();
        this.mRetryCounter = retryCount;
      }
      this.mFailed = false;
    })
    .catch((err: any) => {
      if (err.code && (err.code === 'ENOENT')) {
        this.mLoaded = true;
        return;
      }
      log('warn', 'failed to read plugin file',
        { pluginPath: this.mPluginPath, error: require('util').inspect(err) });
      if (this.mRetryCounter > 0) {
        --this.mRetryCounter;
        this.scheduleRefresh(100);
      } else {
        // giving up...
        this.mLoaded = true;
        this.reportError('failed to read plugin list', err);
      }
    });
  }

  private scheduleRefresh(timeout: number) {
    if (this.mRefreshTimer !== null) {
      clearTimeout(this.mRefreshTimer);
    }
    this.mRefreshTimer = setTimeout(() => {
      this.mRefreshTimer = null;
      this.deserialize();
    }, timeout);
  }

  private startWatch() {
    if (this.mWatch !== undefined) {
      this.mWatch.close();
    }

    if (this.mPluginPath === undefined) {
      return;
    }

    try {
      this.mWatch = fs.watch(this.mPluginPath, {}, (evt, fileName: string) => {
        if (!this.mSerializing &&
                ['loadorder.txt', 'plugins.txt'].indexOf(fileName) !== -1) {
          this.scheduleRefresh(500);
        }
      });
    } catch (err) {
      log('error', 'failed to look for plugin changes', {
        pluginPath: this.mPluginPath, err,
      });
    }
  }
}

export default PluginPersistor;
