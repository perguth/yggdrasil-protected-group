// Get own IP
// Get peer IPs
// Merge
// Publish
// Whitelist for incoming
// Get own Pubkey
// Get peers Pubkeys
// Whitelist keys
// Restart Ygg

// {"peers": {"groupShared": [{"address": "tls://perguth.de:443"}, {"address": "tls://ygg2.perguth.de"}]}}

import * as dotenv from 'dotenv'
import * as child from 'child_process'
import Hyperswarm from 'hyperswarm'
import DHT from '@hyperswarm/dht'
import * as fs from 'fs'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import { addedDiff, deletedDiff } from 'deep-object-diff'
import HJSON from 'hjson'
import * as hyperdb from 'hyperdb'

class YggdrasilProtectedGroup {
  constructor () {
    dotenv.config()
    if (!process.env.SHARED_SECRET) {
      console.error('Missing SHARED_SECRET')
      process.exit()
    }

    this.self = JSON.parse(child.execSync('yggdrasilctl -json getSelf').toString())

    this.topic = b4a.allocUnsafe(32)
    sodium.crypto_generichash(this.topic, Buffer.alloc(32).fill(process.env.SHARED_SECRET))

    this.connections = []

    this.ac = new AbortController()

    this.configFiles = {
      yggdrasil: {},
      yggdrasilProtectedGroup: {
        peers: {
          groupShared: [],
          localOnly: []
        },
        allowedPublicKeys: {
          groupShared: [],
          localOnly: []
        }
      },
      internal: {}
    }

    this.configFiles.yggdrasil = HJSON.rt.parse(fs.readFileSync('/etc/yggdrasil.conf', 'utf8'))

    try {
      this.configFiles.yggdrasilProtectedGroup = JSON.parse(fs.readFileSync('/etc/yggdrasil-protected-group.json', 'utf8'))
    } catch(_) {
      this.saveFile('yggdrasilProtectedGroup')
    }

    try {
      this.configFiles.internal = JSON.parse(fs.readFileSync('/etc/yggdrasil-protected-group.internal.json', 'utf8'))
      const keyPair = this.configFiles.internal.keyPair
      keyPair.publicKey = Buffer.from(keyPair.publicKey)
      keyPair.secretKey = Buffer.from(keyPair.secretKey)
    } catch(_) {}
  }

  saveFile (name) {
    if (name === 'yggdrasil') {
      fs.writeFileSync('/etc/yggdrasil.conf', HJSON.rt.stringify(this.configFiles.yggdrasil))
      return
    }

    if (name === 'yggdrasilProtectedGroup') {
      this.ac.abort()
      fs.writeFileSync('/etc/yggdrasil-protected-group.json', JSON.stringify(this.configFiles.yggdrasilProtectedGroup, null, 2))
      this.ac = new AbortController()
      return
    }

    if (name === 'internal') {
      fs.writeFileSync('/etc/yggdrasil-protected-group.internal.json', JSON.stringify(this.configFiles.internal, null, 2))
      return
    }
  }

  gainAccessToGroup () {
    const groupSeed = Buffer.alloc(32).fill(process.env.SHARED_SECRET)

    const swarm = new Hyperswarm({
      groupSeed,
      firewall: remotePublicKey => {
        const groupHostKey = DHT.keyPair(
          Buffer.alloc(32).fill(process.env.SHARED_SECRET + 'groupHost')
        )
        if (remotePublicKey !== groupHostKey.publicKey) {
          return false
        }
      }
    })

    swarm.on('connection', async conn => {
      this.configFiles.internal.keyPair = DHT.keyPair()

      conn.write(JSON.stringify({
        action: 'access',
        data: {
          hyperswarmPubKey: this.configFiles.internal.keyPair,
          yggdrasilPubKey: this.self.key
        }
      }))

      this.saveFile('internal')
      conn.destroy()
      await swarm.leave(this.topic)
      await swarm.destroy()
      this.start()
    })

    swarm.join(this.topic, { server: false })
  }

  prepareGroupHost () {
    this.configFiles.internal.keyPair = DHT.keyPair(
      Buffer.alloc(32).fill(process.env.SHARED_SECRET + 'groupHost')
    )
    this.saveFile('internal')

    this.start()
  }

  async start () {
    console.log('start')
    if (!this.configFiles.internal.keyPair) {
      if (!process.env.IS_HOST) {
        this.gainAccessToGroup()
        return
      }

      this.prepareGroupHost()
      return
    }

    this.swarm = new Hyperswarm({
      keyPair: this.configFiles.internal.keyPair,
      firewall: remotePublicKey => remotePublicKey in this.configFiles.internal
    })

    // For faster restarts
    process.once('SIGINT', () => this.swarm.destroy())

    this.swarm.on('connection', conn => {
      this.connections.push(conn)
      conn.on('data', data => {
        this.digest('incoming', JSON.parse(data))
      })
    })

    this.swarm.join(this.topic, {
      server: !!process.env.IS_HOST,
      client: !process.env.IS_HOST
    })

    await this.swarm.flush()

    this.watch()
  }

  watch () {
    fs.watch('/etc/yggdrasil-protected-group.json', { signal: this.ac.signal }, _ => {
      console.log('123', fs.readFileSync('/etc/yggdrasil-protected-group.json', 'utf8'))
      const newState = JSON.parse(fs.readFileSync('/etc/yggdrasil-protected-group.json', 'utf8'))

      const diff = addedDiff(this.configFiles.yggdrasilProtectedGroup, newState)
      console.log('diff', JSON.stringify(diff, null, 2))

      if (!Object.keys(diff).length) return

      for (const key1 in diff) {
        for (const key2 in diff[key1]) {
          for (const index in diff[key1][key2]) {
            this.digest('outgoing', {
              action: `${key1}-${key2}-add`,
              data: diff[key1][key2][index]
            })
          }
        }
      }
    })
  }

  digest (direction, data) {
    console.log('digest', direction, data)

    if (direction === 'incoming') {
      if (data.action === 'access') {
        this.configFiles.internal[data.data.hyperswarmPubKey] = data.data.yggdrasilPubKey
        this.saveFile('internal')
        return
      }

      if (data.action.startsWith('peers')) {
        this.configFiles.yggdrasil.Peers.push(data.data.address)
        this.saveFile('yggdrasil')

        this.configFiles.yggdrasilProtectedGroup.peers.groupShared.push(data.data)
        this.saveFile('yggdrasilProtectedGroup')

        child.execSync('service yggdrasil restart')
        return
      }

      if (data.action.startsWith('allowedPublicKeys')) {
        this.configFiles.yggdrasil.AllowedPublicKeys.push(data.data.key)
        this.saveFile('yggdrasil')

        this.configFiles.yggdrasilProtectedGroup.allowedPublicKeys.groupShared.push(data.data)
        this.saveFile('yggdrasilProtectedGroup')

        child.execSync('service yggdrasil restart')
        return
      }
    }

    if (direction === 'outgoing') {
      if (data.action.startsWith('peers')) {
        if (data.action.includes('groupShared')) {
          for (const conn of this.connections) {
            conn.write(JSON.stringify(data))
          }
        }

        this.configFiles.yggdrasil.Peers.push(data.data.address)
        this.saveFile('yggdrasil')

        child.execSync('service yggdrasil restart')
        return
      }

      if (data.action.startsWith('allowedPublicKeys')) {
        if (data.action.includes('groupShared')) {
          for (const conn of this.connections) {
            conn.write(JSON.stringify(data))
          }
        }

        this.configFiles.yggdrasil.AllowedPublicKeys.push(data.data.key)
        this.saveFile('yggdrasil')

        child.execSync('service yggdrasil restart')
        return
      }
    }
  }
}

export const yggdrasilProtectedGroup = new YggdrasilProtectedGroup()

await yggdrasilProtectedGroup.start()
