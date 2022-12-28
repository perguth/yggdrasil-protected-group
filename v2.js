// /etc/yggdrasil-protected-group.conf
// /etc/opt/yggdrasil-proctected-group/state.db

import * as child from 'child_process'
import Hyperswarm from 'hyperswarm'
import DHT from '@hyperswarm/dht'
import * as fs from 'fs'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import HJSON from 'hjson'
import hyperdb from 'hyperdb'

class Pg {
  constructor () {
    console.log('Starting `yggdrasil-protected-group`')

    this.yggSelf = null
    this.path = {
      ygg: '/etc/yggdrasil.conf',
      pg: '/etc/yggdrasil-protected-group.conf',
      swarm: '/etc/opt/yggdrasil-protected-group/swarm.json',
      db: '/etc/opt/yggdrasil-protected-group/hyper.db'
    }
    this.conf = {
      ygg: {},
      pg: {
        IsGroupHost: false,

        SharedSecret: null,
        Peers: {
          GroupShared: [],
          localOnly: []
        },
        AllowedPublicKeys: {
          GroupShared: [],
          localOnly: []
        }
      },
      swarm: {
        topic: null,
        accessKey: null,
        remotePublicKeys: {}
      }
    }
  }

  saveConf (name) {
    if (name === 'swarm') {
      fs.writeFileSync(this.path.swarm, JSON.stringify(
        this.conf.swarm, null, 2
      ))
      return
    }
    fs.writeFileSync(this.path[name], HJSON.rt.stringify(
      this.conf[name]
    ))
  }

  prepare () {
    this.yggSelf = JSON.parse(child.execSync('yggdrasilctl -json getSelf').toString())

    for (const name in this.path) {
      if (name === 'db') continue
      try {
        this.conf[name] = HJSON.rt.parse(
          fs.readFileSync(this.path[name], 'utf8')
        )
      } catch (err) {
        if (err.message.includes(this.path.swarm)) {
          try {
            fs.mkdirSync(/^(.*\/)/g.exec(this.path.swarm)[0])
          } catch (_) {}
          this.saveConf('swarm')
          continue
        }
        if (err.message.includes(this.path.pg)) {
          this.saveConf('pg')
          continue
        }
        console.error('Config file missing', err)
        process.exit(1)
      }
    }

    if (!this.conf.pg.SharedSecret) {
      let sharedSecret = b4a.allocUnsafe(32)
      sodium.crypto_generichash(sharedSecret, Buffer.alloc(32).fill(this.yggSelf.key))
      this.conf.pg.SharedSecret = sharedSecret.toString('hex')
      this.saveConf('pg')
    }

    if (!Object.keys(this.conf.swarm.remotePublicKeys).length) {
      const groupHostKey = (DHT.keyPair(
        Buffer.alloc(32).fill('groupHost' + this.conf.pg.SharedSecret)
      )).publicKey.toString('hex')

      this.conf.swarm.remotePublicKeys[groupHostKey] = 'groupHost'
      this.saveConf('swarm')
    }

    let topic = b4a.allocUnsafe(32)
    sodium.crypto_generichash(topic, Buffer.alloc(32).fill(this.conf.pg.SharedSecret))
    this.conf.swarm.topic = topic.toString('hex')

    this.db = hyperdb(this.path.db, { valueEncoding: 'utf-8' })
  }

  async start () {
    this.prepare()

    if (!this.conf.swarm.keyPair) {
      if (!this.conf.pg.IsGroupHost) {
        this.gainAccessToGroup()
        return
      }
      this.prepareGroupHost()
      return
    }

    this.swarm = new Hyperswarm({
      keyPair: {
        publicKey: Buffer.from(this.conf.swarm.keyPair.publicKey, 'hex'),
        secretKey: Buffer.from(this.conf.swarm.keyPair.secretKey, 'hex')
      },
      firewall: remotePublicKey => {
        remotePublicKey = remotePublicKey.toString('hex')

        // console.log('firewall', remotePublicKey, this.conf.swarm.remotePublicKeys, remotePublicKey in this.conf.swarm.remotePublicKeys)
        if (remotePublicKey in this.conf.swarm.remotePublicKeys) {
          return false // accept connection
        }
        return true
      }
    })
    process.once('SIGINT', () => this.swarm.destroy())

    this.swarm.on('connection', (socket, peerInfo) => {
      if (peerInfo.publicKey.toString('hex') === this.conf.swarm.accessKey) {
        socket.on('data', data => {
          data = JSON.parse(data.toString())

          if (peerInfo.publicKey.toString('hex') === this.conf.swarm.accessKey) {
            this.db.authorize(Buffer.from(data.dbPublicKey, 'hex'))

            this.conf.swarm.remotePublicKeys[data.swarmPublicKey] = {
              publicKey: data.yggPublicKey,
              address: data.yggAddress
            }
            this.saveConf('swarm')

            socket.destroy()

            console.log('New group member authorized')
            return
          }
        })
        socket.end()
        return
      }

      console.log('Group member connected:', `[${this.conf.swarm.remotePublicKeys[peerInfo.publicKey.toString('hex')].address}]`)

      const s = this.db.replicate()
      s.pipe(socket).pipe(s)
    })

    console.log('Common group topic:', this.conf.swarm.topic)
    this.swarm.join(Buffer.from(this.conf.swarm.topic, 'hex'))

    if (this.conf.pg.IsGroupHost) {
      console.log('Acting as group host')
    }
    console.log('Waiting for connections')
  }

  prepareGroupHost () {
    const keyPair = DHT.keyPair(
      Buffer.alloc(32).fill('groupHost' + this.conf.pg.SharedSecret)
    )
    keyPair.publicKey = keyPair.publicKey.toString('hex')
    keyPair.secretKey = keyPair.secretKey.toString('hex')
    this.conf.swarm.keyPair = keyPair

    const accessKey = (DHT.keyPair(
      Buffer.alloc(32).fill(this.conf.pg.SharedSecret)
    )).publicKey.toString('hex')

    this.conf.swarm.accessKey = accessKey
    this.conf.swarm.remotePublicKeys[accessKey] = 'accessKey'
    this.saveConf('swarm')

    console.log('Prepared group host')
    this.start()
  }

  async gainAccessToGroup () {
    const seed = Buffer.alloc(32).fill(this.conf.pg.SharedSecret)

    const swarm = new Hyperswarm({
      seed,
      firewall: remotePublicKey => {
        remotePublicKey = remotePublicKey.toString('hex')

        // console.log('firewall 1', remotePublicKey, this.conf.swarm.remotePublicKeys, remotePublicKey in this.conf.swarm.remotePublicKeys)
        if (remotePublicKey in this.conf.swarm.remotePublicKeys) {
          return true // accept connection
        }
        return true
      }
    })
    process.once('SIGINT', () => swarm.destroy())

    swarm.on('connection', async socket => {
      const keyPair = DHT.keyPair()
      keyPair.publicKey = keyPair.publicKey.toString('hex')
      keyPair.secretKey = keyPair.secretKey.toString('hex')
      this.conf.swarm.keyPair = keyPair

      socket.write(JSON.stringify({
        swarmPublicKey: keyPair.publicKey,
        yggPublicKey: this.yggSelf.key,
        yggAddress: this.yggSelf.address,
        dbPublicKey: this.db.local.key.toString('hex')
      }))

      this.saveConf('swarm')

      socket.end()
      await swarm.clear()
      await swarm.destroy()

      console.log('Gained access to group')
      this.start()
    })

    swarm.join(Buffer.from(this.conf.swarm.topic, 'hex'))
    await swarm.flush()
  }
}

export const pg = new Pg()

await pg.start()
