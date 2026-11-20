// Runtime for running the Delta Chat frontend as a WebXDC app.
// Must be loaded before the frontend bundle (see index.html), like the browser target's runtime.

import '@webxdc/types/global'
import type {
  DesktopSettingsType,
  RC_Config,
  RuntimeInfo,
  Theme,
} from '@deltachat-desktop/shared/shared-types.js'
import type { LocaleData } from '@deltachat-desktop/shared/localize.js'
import type {
  getLogger as getLoggerFunction,
  setLogHandler as setLogHandlerFunction,
} from '@deltachat-desktop/shared/logger.js'
import { getDefaultState } from '@deltachat-desktop/shared/state.js'
import type { Runtime } from '@deltachat-desktop/runtime-interface'
import { BaseDeltaChat, yerpc } from '@deltachat/jsonrpc-client'

import { MockCore } from './mock-core.js'

class MockTransport extends yerpc.BaseTransport {
  constructor(private core: MockCore) {
    super()
  }
  _send(message: yerpc.Message): void {
    const { id, method, params } = message as yerpc.Request
    if (!method) return
    this.core.handle(method, params ?? []).then(
      result =>
        this._onmessage({ jsonrpc: '2.0', id: id!, result: result ?? null }),
      error => {
        // eslint-disable-next-line no-console
        console.warn('[mock core]', method, error)
        this._onmessage({
          jsonrpc: '2.0',
          id: id!,
          error: { code: -1, message: String(error?.message ?? error) },
        })
      }
    )
  }
}

class WebxdcDeltaChat extends BaseDeltaChat<MockTransport> {
  close() {}
}

const notSupported = (what: string) => () => {
  throw new Error(`${what} is not supported in the WebXDC version`)
}
const noop = () => {}

const rcConfig: RC_Config = {
  'log-debug': false,
  'log-to-console': true,
  'machine-readable-stacktrace': false,
  devmode: false,
  theme: undefined,
  'theme-watch': false,
  'translation-watch': false,
  'allow-custom-rpc-server-path': false,
  'allow-unsafe-core-replacement': false,
  minimized: false,
  version: false,
  v: false,
  help: false,
  h: false,
}

const runtimeInfo: RuntimeInfo = {
  isMac: false,
  isAppx: false,
  target: 'browser',
  versions: [{ label: 'Runtime', value: 'WebXDC (mock core)' }],
  // shortcut: placeholder build info, wire up gather-version-info.js if the About dialog matters
  buildInfo: { VERSION: 'webxdc', BUILD_TIMESTAMP: 0, GIT_REF: 'webxdc' },
  isContentProtectionSupported: false,
}

const themes: Theme[] = ['light', 'dark'].map(id => ({
  address: `dc:${id}`,
  name: id[0].toUpperCase() + id.slice(1),
  description: '',
  is_prototype: false,
}))

const settings: DesktopSettingsType = {
  ...getDefaultState(),
  notifications: false,
  locale: navigator.language,
}

async function fetchJson(path: string) {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`)
  return res.json()
}

const runtime: Runtime = {
  createDeltaChatConnection: () =>
    new WebxdcDeltaChat(new MockTransport(new MockCore(window.webxdc)), true),

  async initialize(
    setLogHandler: typeof setLogHandlerFunction,
    _getLogger: typeof getLoggerFunction
  ) {
    // log-to-console already prints everything
    setLogHandler(noop, rcConfig)
  },
  getRC_Config: () => rcConfig,
  getRuntimeInfo: () => runtimeInfo,
  emitUIReady: noop,
  emitUIFullyReady: noop,

  getDesktopSettings: async () => settings,
  async setDesktopSetting(key, value) {
    ;(settings as any)[key] = value
  },
  onDesktopSettingChanged: undefined,

  async getLocaleData(locale?: string): Promise<LocaleData> {
    const untranslated = await fetchJson('locales/_untranslated_en.json')
    for (const l of [locale, locale?.split('-')[0], 'en']) {
      if (!l) continue
      try {
        const messages = await fetchJson(`locales/${l}.json`)
        return {
          locale: l,
          messages: { ...messages, ...untranslated },
          dir: 'ltr',
        }
      } catch {
        // try the next fallback
      }
    }
    throw new Error('could not load any locale')
  },
  async setLocale(locale) {
    settings.locale = locale
  },

  getAvailableThemes: async () => themes,
  async getActiveTheme() {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    let address = settings.activeTheme
    if (address === 'system') address = dark ? 'dc:dark' : 'dc:light'
    const theme = themes.find(t => t.address === address) ?? themes[0]
    const data = await (
      await fetch(`themes/${theme.address.slice(3)}.css`)
    ).text()
    return { theme, data }
  },

  // No filesystem / blobs in a WebXDC app.
  transformBlobURL: () => '',
  transformStickerURL: () => '',
  showOpenFileDialog: async () => {
    throw new Error('Attachments are not supported in the WebXDC version')
  },
  writeTempFileFromBase64: notSupported('Files'),
  writeTempFile: notSupported('Files'),
  copyFileToInternalTmpDir: notSupported('Files'),
  removeTempFile: async () => {},
  downloadFile: notSupported('Downloading files'),
  downloadFiles: notSupported('Downloading files'),
  openPath: notSupported('Opening files'),
  getAppPath: async () => '',
  getConfigPath: () => '',
  deleteSticker: notSupported('Stickers'),
  saveBackgroundImage: notSupported('Background images'),

  readClipboardText: () => navigator.clipboard.readText(),
  readClipboardImage: async () => null,
  writeClipboardText: text => navigator.clipboard.writeText(text),
  writeClipboardImage: notSupported('Copying images'),

  // WebXDC apps have no internet access
  openLink: noop,
  openHelpWindow: noop,
  openLogFile: noop,
  readCurrentLog: async () => '',
  getCurrentLogLocation: () => '',
  reloadWebContent: () => location.reload(),
  openMessageHTML: noop,
  openMapsWebxdc: noop,

  openWebxdc: noop,
  getWebxdcIconURL: () => '',
  deleteWebxdcAccountData: async () => {},
  closeAllWebxdcInstances: noop,
  notifyWebxdcStatusUpdate: noop,
  notifyWebxdcRealtimeData: noop,
  notifyWebxdcMessageChanged: noop,
  notifyWebxdcInstanceDeleted: noop,
  startOutgoingVideoCall: noop,
  openIncomingVideoCallWindow: notSupported('Calls'),

  setBadgeCounter: noop,
  showNotification: noop,
  clearAllNotifications: noop,
  clearNotificationsForAccount: noop,
  clearNotifications: noop,
  setNotificationCallback: noop,

  onDragFileOut: noop,
  setDropListener: noop,
  isDroppedFileFromOutside: () => true,
  getAutostartState: async () => ({ isSupported: false, isRegistered: null }),
  checkMediaAccess: async () => 'denied',
  askForMediaAccess: async () => false,

  onChooseLanguage: undefined,
  onThemeUpdate: undefined,
  onShowDialog: undefined,
  onOpenQrUrl: undefined,
  onWebxdcSendToChat: undefined,
  onResumeFromSleep: undefined,
  onToggleNotifications: undefined,
}

;(window as any).r = runtime
