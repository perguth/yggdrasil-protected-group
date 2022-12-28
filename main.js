import * as child from 'child_process'
import Hyperswarm from 'hyperswarm'
import DHT from '@hyperswarm/dht'
import * as fs from 'fs'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import HJSON from 'hjson'
import crypto from 'crypto'

class YggdrasilProtectedGroup {
  constructor () {
    console.log('Starting `yggdrasil-protected-group`')

    this.sockets = new Set()
    this.mtime = null
    this.yggSelf = null
    this.abortController = null
    this.path = {
      ygg: '/etc/yggdrasil.conf',
      ypg: '/etc/yggdrasil-protected-group.conf',
      swarm: '/etc/opt/yggdrasil-protected-group/swarm.json'
    }
    this.conf = {
      ypg: {
        SharedSecret: null,
        Peers: {
          GroupShared: [],
          LocalOnly: []
        },
        AllowedPublicKeys: {
          GroupShared: [],
          LocalOnly: []
        }
      },
      swarm: {
        topic: null,
        sharedSecret: null,
        sharedKeyPair: null,
        remotePublicKeys: [],
        peers: {},
        keyPair: {}
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
          const ygg = HJSON.parse(fs.readFileSync(this.path.ygg, 'utf8'))
          this.conf.ypg.Peers.GroupShared = ygg.Peers
          this.conf.ypg.AllowedPublicKeys.GroupShared = ygg.AllowedPublicKeys
          this.saveConf('ypg')
          const date = new Date(0)
          fs.utimesSync(this.path.ypg, date, date)
          continue
        }
        console.error('Config file missing', err)
        process.exit(1)
      }
    }

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
      this.conf.swarm.sharedSecretHash !== this.conf.ypg.sharedSecret
    ) {
      const accessKeyPair = (DHT.keyPair(
        Buffer.from(sha256(this.conf.ypg.SharedSecret), 'hex')
      ))
      this.conf.swarm.sharedKeyPair = {
        publicKey: accessKeyPair.publicKey.toString('hex'),
        secretKey: accessKeyPair.secretKey.toString('hex')
      }
      let topic = b4a.allocUnsafe(32)
      sodium.crypto_generichash(topic,
        Buffer.from(sha256(this.conf.ypg.SharedSecret), 'hex')
      )
      this.conf.swarm.topic = topic.toString('hex')
      this.conf.swarm.sharedSecret = this.conf.ypg.sharedSecret
      this.saveConf('swarm')
      const date = new Date(0)
      fs.utimesSync(this.path.ypg, date, date)
    }
  }

  async start () {
    this.prepare()

    this.mtime = fs.statSync(this.path.ypg).mtime

    const swarm = new Hyperswarm({
      keyPair: {
        publicKey: Buffer.from(this.conf.swarm.keyPair.publicKey, 'hex'),
        secretKey: Buffer.from(this.conf.swarm.keyPair.secretKey, 'hex')
      }
    })
    process.once('SIGINT', () => swarm.destroy())

    swarm.on('connection', (socket, peerInfo) => {
      const peerPublicKey = peerInfo.publicKey.toString('hex')

      this.sockets.add(socket)
      socket.on('close', _ => this.sockets.delete(socket))
      socket.on('error', _ => this.sockets.delete(socket))

      socket.on('data', data => {
        const isMember = this.conf.swarm.remotePublicKeys.includes(peerPublicKey)
        const isKnown = !!this.conf.swarm.peers[peerPublicKey]
        if (isMember && isKnown) {
          return
        }

        try {
          data = JSON.parse(data.toString())
        } catch (err) {
          console.error('Received broken JSON from peer:', this.keyToAddress(peerPublicKey), err)
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

          socket.write(JSON.stringify({ peer: {
            swarmPublicKey: this.conf.swarm.keyPair.publicKey,
            yggPublicKey: this.yggSelf.key,
            yggAddress: this.yggSelf.address
          }}))

          console.log('Sent info to new peer:', peerPublicKey)
          return
        }

        if (data.peer) {
          this.conf.swarm.peers[peerPublicKey] = data.peer
          this.saveConf('swarm')
          console.log('Added new group member:', data.peer)

          console.log('Whitelisted peer via UFW:', this.keyToAddress(peerPublicKey))
          child.execSync('echo y | ufw allow in from ' + data.peer.yggAddress)

          this.sync(socket, peerPublicKey)
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

      this.sync(socket, peerPublicKey)
    })

    console.log('Common group topic:', this.conf.swarm.topic)
    swarm.join(Buffer.from(this.conf.swarm.topic, 'hex'))

    this.watch()
  }

  sync (socket, peerPublicKey) {
    console.log('Connected to peer:', this.keyToAddress(peerPublicKey))

    socket.on('data', data => {
      try {
        data = JSON.parse(data.toString())
      } catch (err) {
        console.error('Received broken JSON from peer:', this.keyToAddress(peerPublicKey), err)
        socket.destroy()
        return
      }

      if (data.mtime) {
        data.mtime = new Date(data.mtime)
        if (this.mtime <= data.mtime) {
          return
        }
        this.sendConfig(socket)
        return
      }

      if (data.hjson) {
        console.log('Got newer configuration from peer:', this.keyToAddress(peerPublicKey))
        this.unWatch()
        this.conf.ypg.Peers.GroupShared = data.hjson.Peers
        this.conf.ypg.AllowedPublicKeys.GroupShared = data.hjson.AllowedPublicKeys
        this.mtime = new Date(data.hjson.mtime)
        this.updateYpg()
        this.updateYgg()
        this.watch()
        return
      }
    })

    socket.write(JSON.stringify({ mtime: this.mtime }))
  }

  watch () {
    this.abortController = new AbortController()
    fs.watch(this.path.ypg, { signal: this.abortController.signal }, t => {
      const mtime = fs.statSync(this.path.ypg).mtime
      if (mtime <= this.mtime) {
        return
      }
      this.conf.ypg = HJSON.rt.parse(fs.readFileSync(this.path.ypg, 'utf8'))
      this.mtime = mtime
      for (const socket of this.sockets) {
        this.sendConfig(socket)
        this.updateYgg()
      }
    })
  }

  unWatch () {
    this.abortController.abort()
  }

  sendConfig (socket) {
    socket.write(JSON.stringify({ hjson: {
      Peers: this.conf.ypg.Peers.GroupShared,
      AllowedPublicKeys: this.conf.ypg.AllowedPublicKeys.GroupShared,
      mtime: this.mtime
    }}))
    console.log('Sent newer configuration to peer:', this.keyToAddress(socket.remotePublicKey.toString('hex')))
  }

  updateYpg () {
    fs.writeFileSync(this.path.ypg, HJSON.rt.stringify(this.conf.ypg))
    fs.utimesSync(this.path.ypg, this.mtime, this.mtime)
    console.log('Updated `/etc/yggdrasil-protected-group.conf`')
  }

  updateYgg () {
    fs.writeFileSync(this.path.ygg, HJSON.rt.stringify({
      ...HJSON.rt.parse(fs.readFileSync(this.path.ygg, 'utf8')),
      Peers: [
        ...this.conf.ypg.Peers.GroupShared,
        ...this.conf.ypg.Peers.LocalOnly
      ],
      AllowedPublicKeys: [
        ...this.conf.ypg.AllowedPublicKeys.GroupShared,
        ...this.conf.ypg.AllowedPublicKeys.LocalOnly
      ]
    }))
    child.execSync('service yggdrasil restart')
    console.log('Updated `/etc/yggdrasil.conf` and restarted Yggdrasil')
  }

  keyToAddress (swarmKey) {
    return `[${this.conf.swarm.peers[swarmKey].yggAddress}]`
  }
}

export const ypg = new YggdrasilProtectedGroup()

await ypg.start()

function sha256 (inp) {
  return crypto.createHash('sha256').update(inp).digest('hex')
}
