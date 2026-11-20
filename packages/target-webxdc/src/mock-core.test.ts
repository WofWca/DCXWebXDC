import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockCore, ACCOUNT_ID, CHAT_ID, DM_WARNING } from './mock-core.ts'

// In-memory webxdc network: every peer receives every update, own ones included.
function network() {
  const log: any[] = []
  const listeners: ((u: any) => void)[] = []
  return {
    log,
    peer(name: string): any {
      return {
        selfAddr: `${name}@example.org`,
        selfName: name,
        setUpdateListener(cb: (u: any) => void, serial = 0) {
          log.filter(u => u.serial > serial).forEach(cb)
          listeners.push(cb)
          return Promise.resolve()
        },
        sendUpdate(update: any) {
          const u = { ...update, serial: log.length + 1 }
          log.push(u)
          queueMicrotask(() => listeners.forEach(l => l(u)))
        },
      }
    },
  }
}

test('messages travel between peers as webxdc updates', async () => {
  const net = network()
  const alice = new MockCore(net.peer('alice'))
  const bob = new MockCore(net.peer('bob'))

  const msgId = await alice.handle('send_msg', [
    ACCOUNT_ID,
    CHAT_ID,
    { text: 'hi bob' },
  ])
  const [own] = Object.values(
    await alice.handle('get_messages', [ACCOUNT_ID, [msgId]])
  ) as any[]
  assert.equal(own.text, 'hi bob')
  assert.equal(own.fromId, 1) // self

  const bobMsg = await bob.handle('get_message', [ACCOUNT_ID, msgId])
  assert.equal(bobMsg.text, 'hi bob')
  assert.equal(bobMsg.sender.displayName, 'alice')

  const events = await bob.handle('get_next_event_batch', [])
  assert.ok(
    events.some(
      (e: any) => e.event.kind === 'IncomingMsg' && e.event.msgId === msgId
    )
  )
  assert.deepEqual(
    (await bob.handle('get_full_chat_by_id', [ACCOUNT_ID, CHAT_ID])).contactIds,
    [1, 10]
  )
})

test('late joiner replays history without events, ignores junk updates', async () => {
  const net = network()
  const alice = new MockCore(net.peer('alice'))
  await alice.handle('misc_send_text_message', [ACCOUNT_ID, CHAT_ID, 'first'])
  net.peer('mallory').sendUpdate({ payload: { text: 42 } })
  await new Promise(r => setTimeout(r))

  const carol = new MockCore(net.peer('carol'))
  const items = await carol.handle('get_message_list_items', [
    ACCOUNT_ID,
    CHAT_ID,
    false,
    false,
  ])
  assert.equal(items.length, 1)
  const pending = carol.handle('get_next_event_batch', [])
  const nothing = Symbol()
  assert.equal(
    await Promise.race([pending, new Promise(r => setTimeout(r, 20, nothing))]),
    nothing
  )
})

test('unknown methods are rejected', async () => {
  const core = new MockCore(network().peer('alice'))
  await assert.rejects(core.handle('delete_account', [1]), /not supported/)
})

test('1:1 messages reach only the recipient, peers are discovered on launch', async () => {
  const net = network()
  const alice = new MockCore(net.peer('alice'))
  const bob = new MockCore(net.peer('bob'))
  const carol = new MockCore(net.peer('carol'))
  await new Promise(r => setTimeout(r))

  // hello updates: everyone has a 1:1 chat with everyone, before writing anything
  const aliceChats = await alice.handle('get_chatlist_entries', [ACCOUNT_ID])
  assert.equal(aliceChats.length, 3) // group + bob + carol
  const dm = await alice.handle('create_chat_by_contact_id', [ACCOUNT_ID, 10])
  assert.equal(
    (await alice.handle('get_contact', [ACCOUNT_ID, 10])).name,
    'bob'
  )

  const [warning] = await alice.handle('get_message_ids', [ACCOUNT_ID, dm])
  const info = await alice.handle('get_message', [ACCOUNT_ID, warning])
  assert.equal(info.isInfo, true)
  assert.equal(info.text, DM_WARNING)

  await alice.handle('send_msg', [ACCOUNT_ID, dm, { text: 'psst bob' }])
  await new Promise(r => setTimeout(r))
  const texts = async (core: MockCore) => {
    const chats = await core.handle('get_chatlist_entries', [ACCOUNT_ID])
    const all = []
    for (const chatId of chats) {
      for (const id of await core.handle('get_message_ids', [
        ACCOUNT_ID,
        chatId,
      ]))
        all.push({
          chatId,
          text: (await core.handle('get_message', [ACCOUNT_ID, id])).text,
        })
    }
    return all
  }
  const bobGot = (await texts(bob)).find(m => m.text === 'psst bob')
  assert.ok(bobGot)
  assert.notEqual(bobGot.chatId, CHAT_ID)
  const bobDm = await bob.handle('get_full_chat_by_id', [
    ACCOUNT_ID,
    bobGot.chatId,
  ])
  assert.equal(bobDm.chatType, 'Single')
  assert.equal(bobDm.name, 'alice')
  assert.ok(!(await texts(carol)).some(m => m.text === 'psst bob'))

  // 1:1 text must not leak into the host chat via the summary
  assert.ok(!net.log.some(u => u.summary?.includes('psst')))
})
