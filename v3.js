import * as child from 'child_process'
import Hyperswarm from 'hyperswarm'
import DHT from '@hyperswarm/dht'
import * as fs from 'fs'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import HJSON from 'hjson'
import Corestore from 'corestore'
import Autobase from 'autobase'
import crypto from 'crypto'
import Hyperbee from 'hyperbee'

class Ypg {
  constructor () {
    console.log('Starting `yggdrasil-protected-group`')

    this.yggSelf = null
    this.writer = null
    this.viewOutput = null
    this.autobase = null
    this.store = null
    this.bee = null
    this.path = {
      ygg: '/etc/yggdrasil.conf',
      ypg: '/etc/yggdrasil-protected-group.conf',
      swarm: '/etc/opt/yggdrasil-protected-group/swarm.json',
      db: '/etc/opt/yggdrasil-protected-group/hyper.db'
    }
    this.conf = {
      ygg: {},
      ypg: {
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
        sharedKeyPair: null,
        remotePublicKeys: [],
        peers: {}
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
        if (err.message.includes(this.path.ypg)) {
          this.saveConf('ypg')
          continue
        }
        console.error('Config file missing', err)
        process.exit(1)
      }
    }

    this.store = new Corestore(this.path.db)

    if (!this.conf.ypg.SharedSecret) {
      let sharedSecret = b4a.allocUnsafe(32)
      sodium.crypto_generichash(sharedSecret, Buffer.alloc(32).fill(this.yggSelf.key))
      this.conf.ypg.SharedSecret = sharedSecret.toString('hex')
      this.saveConf('ypg')
    }

    if (!this.conf.swarm.keyPair) {
      const keyPair = DHT.keyPair()
      this.conf.swarm.keyPair = {
        publicKey: keyPair.publicKey.toString('hex'),
        secretKey: keyPair.secretKey.toString('hex')
      }
      this.saveConf('swarm')
    }

    if (
      !this.conf.swarm.sharedSecret ||
      this.conf.swarm.sharedSecretHash !== sha256(this.conf.ypg.sharedSecret)
    ) {
      const accessKeyPair = (DHT.keyPair(
        Buffer.alloc(32).fill(this.conf.ypg.SharedSecret) // use sha
      ))
      this.conf.swarm.sharedKeyPair = {
        publicKey: accessKeyPair.publicKey.toString('hex'),
        secretKey: accessKeyPair.secretKey.toString('hex')
      }

      let topic = b4a.allocUnsafe(32)
      sodium.crypto_generichash(topic, Buffer.alloc(32).fill(this.conf.ypg.SharedSecret)) // use sha
      this.conf.swarm.topic = topic.toString('hex')

      this.saveConf('swarm')
    }
  }

  async start () {
    this.prepare()

    this.writer = this.store.get({ name: 'writer' })
    this.viewOutput = this.store.get({ name: 'view' })

    await this.writer.ready()

    this.autobase = new Autobase({
      inputs: [this.writer],
      localInput: this.writer,
      outputs: [this.viewOutput],
      localOutput: this.viewOutput
    })

    const swarm = new Hyperswarm({
      keyPair: {
        publicKey: Buffer.from(this.conf.swarm.keyPair.publicKey, 'hex'),
        secretKey: Buffer.from(this.conf.swarm.keyPair.secretKey, 'hex')
      }
    })
    process.once('SIGINT', () => swarm.destroy())

    swarm.on('connection', (socket, peerInfo) => {
      const peerPublicKey = peerInfo.publicKey.toString('hex')

      socket.on('data', data => {
        const isMember = this.conf.swarm.remotePublicKeys.includes(peerPublicKey)
        const isKnown = !!this.conf.swarm.peers[peerPublicKey]
        if (isMember && isKnown) {
          return
        }

        try {
          data = JSON.parse(data.toString())
        } catch (err) {
          console.error('Received broken JSON from peer:', peerPublicKey, err)
          socket.destroy()
          return
        }

        if (data.hello) {
          data.hello = Buffer.from(data.hello)
          if (!sodium.crypto_sign_open(
            b4a.allocUnsafe(data.hello.length - sodium.crypto_sign_BYTES),
            data.hello,
            Buffer.from(this.conf.swarm.sharedKeyPair.publicKey, 'hex')
          )) {
            console.warn('Could not authenticate peer:', peerPublicKey)
            socket.destroy()
            return
          }
          if (!isMember) {
            this.conf.swarm.remotePublicKeys.push(peerPublicKey)
            this.saveConf('swarm')
          }

          socket.write(JSON.stringify({ info: {
            peer: {
              swarmPublicKey: this.conf.swarm.keyPair.publicKey,
              yggPublicKey: this.yggSelf.key,
              yggAddress: this.yggSelf.address
            },
            hyper: {
              writerKey: this.writer.key,
              viewOutputKey: this.viewOutput.key
            }
          }}))

          console.log('Sent info to new peer:', peerPublicKey)
          return
        }

        if (data.info) {
          this.conf.swarm.peers[peerPublicKey] = data.info.peer
          this.saveConf('swarm')

          this.autobase.addInput(this.store.get(Buffer.from(data.info.hyper.writerKey)))
          this.autobase.addOutput(this.store.get(Buffer.from(data.info.hyper.viewOutputKey)))

          console.log('Got info from new peer:', peerPublicKey, data.info)
        }
      })

      const isMember = this.conf.swarm.remotePublicKeys.includes(peerPublicKey)
      const isKnown = !!this.conf.swarm.peers[peerPublicKey]
      if (!isMember || !isKnown) {
        let signedMessage = b4a.allocUnsafe(32 + sodium.crypto_sign_BYTES)
        sodium.crypto_sign(
          signedMessage,
          Buffer.alloc(32).fill(sodium.randombytes_random()),
          Buffer.from(this.conf.swarm.sharedKeyPair.secretKey, 'hex')
        )
        socket.write(JSON.stringify({ hello: signedMessage }))
        return
      }
    })

    console.log('Common group topic:', this.conf.swarm.topic)
    swarm.join(Buffer.from(this.conf.swarm.topic, 'hex'))

    this.replicate()
  }

  async replicate () {
    await this.autobase.ready()

    const swarm = new Hyperswarm({
      keyPair: {
        publicKey: Buffer.from(this.conf.swarm.keyPair.publicKey, 'hex'),
        secretKey: Buffer.from(this.conf.swarm.keyPair.secretKey, 'hex')
      }
    })
    process.once('SIGINT', () => swarm.destroy())
    swarm.on('connection', socket => this.store.replicate(socket))
    swarm.join(Buffer.from(sha256(this.conf.swarm.topic), 'hex'))

    const self = this
    this.autobase.start({
      unwrap: true,
      async apply(batch) {
        const b = self.bee.batch({ update: false })

        for (const { value } of batch) {
          const op = JSON.parse(value)
          if (op.type === 'put') await b.put(op.key, op.value)
        }
        await b.flush()
      }
    })
    this.bee = new Hyperbee(this.autobase.view, {
      extension: false,
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
  }

  async put (key, value) {
    const op = Buffer.from(JSON.stringify({ type: 'put', key, value }))
    return await this.autobase.append(op)
  }

  async get (key) {
    return await this.bee.get(key)
  }
}

export const ypg = new Ypg()

await ypg.start()

function sha256 (inp) {
  return crypto.createHash('sha256').update(inp).digest('hex')
}
