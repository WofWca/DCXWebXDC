// A tiny in-page stand-in for the deltachat JSON-RPC server.
// One configured account with one group chat plus a 1:1 chat per peer.
// Messages are WebXDC status updates, so everyone in the real chat receives
// them. 1:1 messages are only hidden by the receiving apps, not encrypted.
//
// shortcut: only text messages, no attachments, reactions, edits, unread
// counters or contact management. Extend `handlers` when the UI needs more.

import type { T } from '@deltachat/jsonrpc-client'
import type { ReceivedStatusUpdate, Webxdc } from '@webxdc/types'

export type Payload = {
  addr: string
  name: string
  time: number
  nonce: string
  /** absent for `hello` */
  text?: string
  /** recipient's addr for 1:1 messages, absent for the group chat */
  to?: string
  /** sent once on first launch so peers discover us before we write anything */
  hello?: true
}

export const ACCOUNT_ID = 1
export const CHAT_ID = 10
const SELF_ID = 1 // DC_CONTACT_ID_SELF
const INFO_ID = 2 // DC_CONTACT_ID_INFO
const DM_CHAT_BASE = 1000 // 1:1 chat id = DM_CHAT_BASE + contact id
const FIRST_ID = 10 // ids below 10 are reserved by core
const STATE_IN_SEEN = 16
const STATE_OUT_DELIVERED = 26
const CONNECTIVITY_CONNECTED = 4000

type StoredContact = { id: number; addr: string; name: string }
type StoredMessage = {
  id: number
  chatId: number
  fromId: number
  text: string
  time: number
}

export const DM_WARNING =
  'Everyone in the chat where this app is shared can read messages in this chat.'

function color(seed: string) {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360
  return `hsl(${h}, 55%, 45%)`
}

// Peers can put anything into an update, so check it before trusting it.
function isPayload(p: any): p is Payload {
  return (
    p &&
    typeof p.addr === 'string' &&
    typeof p.name === 'string' &&
    typeof p.nonce === 'string' &&
    Number.isFinite(p.time) &&
    (p.hello === true || typeof p.text === 'string') &&
    (p.to === undefined || typeof p.to === 'string')
  )
}

export class MockCore {
  private contacts: StoredContact[] = []
  private messages: StoredMessage[] = []
  private config: Record<string, string | null>
  private events: T.Event[] = []
  private wakeEventLoop = () => {}
  private pendingSends = new Map<string, (msgId: number) => void>()
  private replaying = true
  private announced = false
  readonly ready: Promise<void>

  // not a parameter property: node's type stripping (used by the tests) can't handle those
  private webxdc: Webxdc<Payload>

  constructor(webxdc: Webxdc<Payload>) {
    this.webxdc = webxdc
    this.config = {
      addr: webxdc.selfAddr,
      configured_addr: webxdc.selfAddr,
      displayname: webxdc.selfName,
      selfstatus: '',
    }
    this.ready = webxdc
      .setUpdateListener(update => this.onUpdate(update), 0)
      .then(() => {
        this.replaying = false
        if (!this.announced) this.send({ hello: true })
      })
  }

  async handle(method: string, params: any): Promise<any> {
    await this.ready
    const handler = this.handlers[method]
    if (!handler) {
      throw new Error(`${method} is not supported in the WebXDC version`)
    }
    return handler(...(Array.isArray(params) ? params : [params]))
  }

  private onUpdate({ payload }: ReceivedStatusUpdate<Payload>) {
    if (!isPayload(payload)) return
    const self = this.webxdc.selfAddr
    const fromId =
      payload.addr === self
        ? SELF_ID
        : this.contactFor(payload.addr, payload.name, payload.time).id
    if (fromId === SELF_ID && !this.announced) {
      this.announced = true
      this.addGroupInfo('You joined the group.', payload.time)
    }
    if (payload.hello) return

    let chatId = CHAT_ID
    if (payload.to !== undefined) {
      const peer =
        fromId === SELF_ID
          ? this.contacts.find(c => c.addr === payload.to)
          : payload.to === self
            ? this.contacts.find(c => c.id === fromId)
            : undefined // someone else's 1:1 message
      if (!peer) return
      chatId = DM_CHAT_BASE + peer.id
    }
    const id = this.store(chatId, fromId, payload.text ?? '', payload.time)

    this.pendingSends.get(payload.nonce)?.(id)
    this.pendingSends.delete(payload.nonce)

    if (this.replaying) return
    const kind = fromId === SELF_ID ? 'MsgsChanged' : 'IncomingMsg'
    this.emit({ kind, chatId, msgId: id })
    this.emit({ kind: 'ChatlistItemChanged', chatId })
    this.emit({ kind: 'ChatlistChanged' })
  }

  private store(chatId: number, fromId: number, text: string, time: number) {
    const id = FIRST_ID + this.messages.length
    this.messages.push({ id, chatId, fromId, text, time })
    return id
  }

  private contactFor(addr: string, name: string, time: number) {
    let contact = this.contacts.find(c => c.addr === addr)
    if (!contact) {
      contact = { id: FIRST_ID + this.contacts.length, addr, name }
      this.contacts.push(contact)
      this.store(DM_CHAT_BASE + contact.id, INFO_ID, DM_WARNING, time)
      this.addGroupInfo(`${name} joined the group.`, time)
    }
    contact.name = name
    return contact
  }

  private addGroupInfo(text: string, time: number) {
    this.store(CHAT_ID, INFO_ID, text, time)
    if (this.replaying) return
    this.emit({ kind: 'ChatModified', chatId: CHAT_ID })
    // msgId 0 makes an open chat reload its message list
    this.emit({ kind: 'MsgsChanged', chatId: CHAT_ID, msgId: 0 })
    this.emit({ kind: 'ChatlistItemChanged', chatId: CHAT_ID })
    this.emit({ kind: 'ChatlistChanged' })
  }

  private emit(event: T.EventType) {
    this.events.push({ contextId: ACCOUNT_ID, event })
    this.wakeEventLoop()
  }

  private send(fields: Pick<Payload, 'text' | 'to' | 'hello'>) {
    const payload: Payload = {
      addr: this.webxdc.selfAddr,
      name: this.config.displayname || this.webxdc.selfName,
      time: Math.floor(Date.now() / 1000),
      nonce: crypto.randomUUID(),
      ...fields,
    }
    // a summary is shown to the whole host chat, so only set it for the group
    const isGroupMsg = fields.text !== undefined && fields.to === undefined
    const summary = `${payload.name}: ${fields.text}`.slice(0, 100)
    this.webxdc.sendUpdate(isGroupMsg ? { payload, summary } : { payload }, '')
    return payload.nonce
  }

  private sendText(chatId: number, text: string): Promise<number> {
    const to = chatId === CHAT_ID ? undefined : this.dmContact(chatId).addr
    const nonce = this.send({ text, to })
    // resolved when our own update comes back through the update listener
    return new Promise<number>(r => this.pendingSends.set(nonce, r))
  }

  private dmContact(chatId: number) {
    const contact = this.contacts.find(c => c.id === chatId - DM_CHAT_BASE)
    if (!contact) throw new Error(`chat ${chatId} not found`)
    return contact
  }

  private contact(id: number): T.Contact {
    const c =
      id === SELF_ID
        ? {
            id,
            addr: this.webxdc.selfAddr,
            name: this.config.displayname || this.webxdc.selfName,
          }
        : this.contacts.find(c => c.id === id)
    if (!c) throw new Error(`contact ${id} not found`)
    return {
      id: c.id,
      address: c.addr,
      color: color(c.addr),
      authName: c.name,
      status: '',
      displayName: c.name,
      name: c.name,
      profileImage: null,
      isBlocked: false,
      isKeyContact: true,
      e2eeAvail: true,
      lastSeen: 0,
      freshness: 'Normal',
      isBot: false,
    } satisfies T.Contact
  }

  private message(id: number): T.Message {
    const m = this.messages[id - FIRST_ID]
    if (!m) throw new Error(`message ${id} not found`)
    return {
      id: m.id,
      chatId: m.chatId,
      fromId: m.fromId,
      quote: null,
      parentId: null,
      text: m.text,
      isEdited: false,
      hasLocation: false,
      hasHtml: false,
      viewType: 'Text',
      state: m.fromId === SELF_ID ? STATE_OUT_DELIVERED : STATE_IN_SEEN,
      error: null,
      timestamp: m.time,
      sortTimestamp: m.time,
      receivedTimestamp: m.time,
      hasDeviatingTimestamp: false,
      subject: '',
      showPadlock: true,
      isInfo: m.fromId === INFO_ID,
      isForwarded: false,
      isBot: false,
      systemMessageType: 'Unknown',
      infoContactId: null,
      duration: 0,
      dimensionsHeight: 0,
      dimensionsWidth: 0,
      overrideSenderName: null,
      sender: this.contact(m.fromId === INFO_ID ? SELF_ID : m.fromId),
      file: null,
      fileMime: null,
      fileBytes: 0,
      fileName: null,
      webxdcHref: null,
      downloadState: 'Done',
      originalMsgId: null,
      savedMessageId: null,
      isPinned: false,
      reactions: null,
      vcardContact: null,
    } satisfies T.Message
  }

  private account(): T.Account {
    return {
      kind: 'Configured',
      id: ACCOUNT_ID,
      displayName: this.config.displayname,
      profileImage: null,
      color: color(this.webxdc.selfAddr),
      privateTag: null,
    } satisfies T.Account
  }

  private chat(chatId: number): T.FullChat {
    if (chatId !== CHAT_ID) {
      const c = this.dmContact(chatId)
      return {
        ...this.chat(CHAT_ID),
        id: chatId,
        name: c.name,
        chatType: 'Single',
        contactIds: [c.id],
        color: color(c.addr),
      }
    }
    return {
      id: CHAT_ID,
      name: 'Everyone',
      isEncrypted: true,
      profileImage: null,
      archived: false,
      pinned: false,
      chatType: 'Group',
      isUnpromoted: false,
      isSelfTalk: false,
      contactIds: [SELF_ID, ...this.contacts.map(c => c.id)],
      pastContactIds: [],
      color: color('chat'),
      freshMessageCounter: 0,
      isContactRequest: false,
      isDeviceChat: false,
      selfInGroup: true,
      isMuted: false,
      ephemeralTimer: 0,
      canSend: true,
      freshness: 'Normal',
      mailingListAddress: null,
    } satisfies T.FullChat
  }

  private chatMessages(chatId: number) {
    return this.messages.filter(m => m.chatId === chatId)
  }

  private chatlistItem(chatId: number): T.ChatListItemFetchResult {
    const chat = this.chat(chatId)
    const isGroup = chatId === CHAT_ID
    const last = this.chatMessages(chatId).at(-1)
    return {
      kind: 'ChatListItem',
      id: chat.id,
      name: chat.name,
      avatarPath: null,
      color: chat.color,
      chatType: chat.chatType,
      lastUpdated: last ? last.time * 1000 : null,
      summaryText1:
        last && isGroup && last.fromId !== INFO_ID
          ? this.contact(last.fromId).displayName
          : '',
      summaryText2: last?.text ?? '',
      summaryStatus: last ? this.message(last.id).state : 0,
      isEncrypted: true,
      isGroup,
      freshMessageCounter: 0,
      isSelfTalk: false,
      isDeviceTalk: false,
      isSendingLocation: false,
      isSelfInGroup: true,
      isArchived: false,
      isPinned: false,
      isMuted: false,
      isContactRequest: false,
      dmChatContact: isGroup ? null : chat.contactIds[0],
      freshness: 'Normal',
      lastMessageType: last ? 'Text' : null,
      lastMessageId: last?.id ?? null,
    } satisfies T.ChatListItemFetchResult
  }

  private byId<V>(ids: number[], get: (id: number) => V) {
    return Object.fromEntries(ids.map(id => [id, get(id)]))
  }

  // Keyed by wire (snake_case) method name. Params are positional.
  private handlers: Record<string, (...args: any[]) => unknown> = {
    get_next_event_batch: async () => {
      while (this.events.length === 0) {
        await new Promise<void>(r => (this.wakeEventLoop = r))
      }
      return this.events.splice(0)
    },

    // accounts
    get_system_info: () => ({}),
    set_stock_strings: () => null,
    add_device_message: () => 0,
    get_all_account_ids: () => [ACCOUNT_ID],
    get_all_accounts: () => [this.account()],
    get_account_info: () => this.account(),
    get_selected_account_id: () => ACCOUNT_ID,
    select_account: () => null,
    is_configured: () => true,
    start_io: () => null,
    stop_io: () => null,
    start_io_for_all_accounts: () => null,
    stop_io_for_all_accounts: () => null,
    maybe_network: () => null,
    get_connectivity: () => CONNECTIVITY_CONNECTED,
    get_config: (_acc: number, key: string) => this.config[key] ?? null,
    batch_get_config: (_acc: number, keys: string[]) =>
      Object.fromEntries(keys.map(k => [k, this.config[k] ?? null])),
    set_config: (_acc: number, key: string, value: string | null) => {
      this.config[key] = value
      return null
    },
    batch_set_config: (_acc: number, values: Record<string, string | null>) => {
      Object.assign(this.config, values)
      return null
    },

    // chat list
    get_chatlist_entries: (_acc: number, _flags: unknown, query?: string) =>
      [CHAT_ID, ...this.contacts.map(c => DM_CHAT_BASE + c.id)]
        .filter(id =>
          this.chat(id)
            .name.toLowerCase()
            .includes((query ?? '').toLowerCase())
        )
        .map(id => ({ id, time: this.chatMessages(id).at(-1)?.time ?? 0 }))
        .sort((a, b) => b.time - a.time)
        .map(c => c.id),
    get_chatlist_items_by_entries: (_acc: number, ids: number[]) =>
      this.byId(ids, id => this.chatlistItem(id)),
    get_full_chat_by_id: (_acc: number, chatId: number) => this.chat(chatId),
    get_basic_chat_info: (_acc: number, chatId: number) => this.chat(chatId),
    get_chat_contacts: (_acc: number, chatId: number) =>
      this.chat(chatId).contactIds,
    get_chat_id_by_contact_id: (_acc: number, contactId: number) =>
      this.contacts.some(c => c.id === contactId)
        ? DM_CHAT_BASE + contactId
        : null,
    create_chat_by_contact_id: (_acc: number, contactId: number) => {
      const chatId = DM_CHAT_BASE + contactId
      this.dmContact(chatId) // throws for unknown contacts
      return chatId
    },
    get_fresh_msgs: () => [],
    get_fresh_msg_cnt: () => 0,
    get_first_unread_message_of_chat: () => null,
    marknoticed_chat: () => null,
    markseen_msgs: () => null,
    get_draft: () => null,
    misc_set_draft: () => null,
    remove_draft: () => null,
    get_chat_ephemeral_timer: () => 0,
    get_chat_media: () => [],
    get_pinned_messages: () => [],

    // messages
    get_message_list_items: (_acc: number, chatId: number) =>
      this.chatMessages(chatId).map(m => ({ kind: 'message', msg_id: m.id })),
    get_message_ids: (_acc: number, chatId: number) =>
      this.chatMessages(chatId).map(m => m.id),
    get_message: (_acc: number, id: number) => this.message(id),
    get_messages: (_acc: number, ids: number[]) =>
      this.byId(ids, id => {
        try {
          return { kind: 'message', ...this.message(id) }
        } catch (e) {
          return { kind: 'loadingError', error: String(e) }
        }
      }),
    send_msg: (_acc: number, chatId: number, data: T.MessageData) => {
      if (data.file) throw new Error('Attachments are not supported')
      return this.sendText(chatId, data.text ?? '')
    },
    misc_send_text_message: (_acc: number, chatId: number, text: string) =>
      this.sendText(chatId, text),

    // contacts
    get_contact: (_acc: number, id: number) => this.contact(id),
    get_contacts_by_ids: (_acc: number, ids: number[]) =>
      this.byId(ids, id => this.contact(id)),
    get_contact_ids: () => this.contacts.map(c => c.id),
    get_blocked_contacts: () => [],
  }
}
