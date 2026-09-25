const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld('pet', {
  init: () => ipcRenderer.invoke('pet:init'),
  setInteractive: (v) => ipcRenderer.send('mouse:interactive', v),
  dragPress: () => ipcRenderer.send('drag:press'),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragEnd: () => ipcRenderer.invoke('drag:end'),
  layout: (geo) => ipcRenderer.invoke('win:layout', geo),
  hideWindow: () => ipcRenderer.send('win:hide'),
  contextMenu: () => ipcRenderer.send('menu:context'),
  send: (text) => ipcRenderer.invoke('ai:send', text),
  cancel: () => ipcRenderer.send('ai:cancel'),
  onToken: on('ai:token'),
  onCharacter: on('pet:character'),
  onVisibility: on('pet:visibility'),
  onChatReset: on('chat:reset'),
  // Pet window -> balloon window (via main).
  bubble: (content) => ipcRenderer.send('bubble:content', content),
  bubbleShow: (opts) => ipcRenderer.send('bubble:show', opts),
  bubbleHide: () => ipcRenderer.send('bubble:hide'),
  onBubbleSubmit: on('bubble:submit'),
  onBubbleTyping: on('bubble:typing'),
  onBubbleEscape: on('bubble:escape'),
  // Used inside the balloon window.
  balloon: {
    onContent: on('bubble:content'),
    onPlace: on('bubble:place'),
    onOpen: on('bubble:open'),
    onFocus: on('bubble:focus'),
    size: (h) => ipcRenderer.send('bubble:size', h),
    submit: (text) => ipcRenderer.send('bubble:submit', text),
    typing: () => ipcRenderer.send('bubble:typing'),
    escape: () => ipcRenderer.send('bubble:escape'),
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.send('settings:set', patch),
  fitSettings: (fit) => ipcRenderer.send('settings:fit', fit),
  onSettings: on('settings:changed'),
  onSettingsTab: on('settings:tab'),
  auditCharacters: () => ipcRenderer.invoke('audit:characters'),
  selftest: {
    log: (line) => ipcRenderer.send('selftest:log', line),
    capture: (name) => ipcRenderer.invoke('selftest:capture', name),
    done: (code) => ipcRenderer.send('selftest:done', code),
    geometry: () => ipcRenderer.invoke('selftest:geometry'),
  },
});
