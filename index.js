import b4a from 'b4a'
import * as child from 'child_process'
import crypto from 'crypto'
import * as fs from 'fs'
import HJSON from 'hjson'
import Hyperswarm from 'hyperswarm'
import DHT from '@hyperswarm/dht'
import sodium from 'sodium-universal'

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
            const folderPath = /^(.*\/)/g.exec(this.path.swarm)[0]
            fs.mkdirSync(folderPath)
            child.execSync(`chmod g-r ${folderPath}`)
          } catch (_) {}
          this.saveConf('swarm')
          child.execSync(`chmod g-r ${this.path.swarm}`)
          continue
        }
        if (err.message.includes(this.path.ypg)) {
          const ygg = HJSON.parse(fs.readFileSync(this.path.ygg, 'utf8'))
          this.conf.ypg.Peers.GroupShared = ygg.Peers
          this.conf.ypg.AllowedPublicKeys.GroupShared = ygg.AllowedPublicKeys
          this.saveConf('ypg')
          const date = new Date(0)
          fs.utimesSync(this.path.ypg, date, date)
          child.execSync(`chmod g-r ${this.path.ypg}`)
          continue
        }
        console.error('Config file missing', err)
        process.exit(1)
      }
    }

    if (!this.conf.ypg.SharedSecret) {
      const sharedSecret = b4a.allocUnsafe(32)
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
      this.conf.swarm.sharedSecret !== this.conf.ypg.SharedSecret
    ) {
      console.log('`SharedSecret` changed. Deprecating config.')
      const accessKeyPair = (DHT.keyPair(
        Buffer.from(sha256(this.conf.ypg.SharedSecret), 'hex')
      ))
      this.conf.swarm.sharedKeyPair = {
        publicKey: accessKeyPair.publicKey.toString('hex'),
        secretKey: accessKeyPair.secretKey.toString('hex')
      }
      const topic = b4a.allocUnsafe(32)
      sodium.crypto_generichash(topic,
        Buffer.from(sha256(this.conf.ypg.SharedSecret), 'hex')
      )
      this.conf.swarm.topic = topic.toString('hex')
      this.conf.swarm.sharedSecret = this.conf.ypg.SharedSecret
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
      const handleClose = _ => {
        if (!this.sockets.has(socket)) {
          return
        }
        console.log(
          '(Previous) connection to peer closed:',
          this.conf.swarm.peers[peerPublicKey] && this.keyToAddress(peerPublicKey)
        )
        this.sockets.delete(socket)
      }
      socket.on('close', handleClose)
      socket.on('error', handleClose)

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

          socket.write(JSON.stringify({
            peer: {
              swarmPublicKey: this.conf.swarm.keyPair.publicKey,
              yggPublicKey: this.yggSelf.key,
              yggAddress: this.yggSelf.address
            }
          }))

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
        const signedMessage = b4a.allocUnsafe(32 + sodium.crypto_sign_BYTES)
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
        data = HJSON.rt.parse(data.toString())
      } catch (err) {
        console.error('Received broken JSON from peer:', this.keyToAddress(peerPublicKey), err)
        socket.destroy()
        return
      }

      if (data.mtime) {
        data.mtime = new Date(data.mtime)
        if (this.mtime <= data.mtime) {
          console.log('No updates available for:', this.keyToAddress(peerPublicKey))
          return
        }
        this.sendConfig(socket)
        return
      }

      if (data.hjson) {
        data.hjson.mtime = new Date(data.hjson.mtime)
        if (this.mtime >= data.hjson.mtime) {
          console.log('Discarding config from peer (already up to date):', this.keyToAddress(peerPublicKey))
          return
        }
        console.log('Got newer configuration from peer:', this.keyToAddress(peerPublicKey))
        this.conf.ypg.Peers.GroupShared = data.hjson.Peers
        this.conf.ypg.AllowedPublicKeys.GroupShared = data.hjson.AllowedPublicKeys
        this.mtime = data.hjson.mtime
        this.updateYpg()
        this.updateYgg()
      }
    })

    socket.write(JSON.stringify({ mtime: this.mtime }))
  }

  watch () {
    let debounce
    this.abortController = new AbortController()
    fs.watch(this.path.ypg, { signal: this.abortController.signal }, _ => {
      const mtime = fs.statSync(this.path.ypg).mtime
      if (+debounce === +mtime) {
        return
      }
      console.log(`Detected file changes in \`${this.path.ypg}\``)
      debounce = mtime
      this.mtime = mtime
      this.conf.ypg = HJSON.rt.parse(fs.readFileSync(this.path.ypg, 'utf8'))
      for (const socket of this.sockets) {
        this.sendConfig(socket)
      }
      this.updateYgg()
    })
  }

  unWatch () {
    this.abortController.abort()
  }

  sendConfig (socket) {
    socket.write(HJSON.rt.stringify({
      hjson: {
        Peers: this.conf.ypg.Peers.GroupShared,
        AllowedPublicKeys: this.conf.ypg.AllowedPublicKeys.GroupShared,
        mtime: this.mtime.toJSON()
      }
    }))
    console.log('Sent config to peer:', this.keyToAddress(socket.remotePublicKey.toString('hex')))
  }

  updateYpg () {
    this.unWatch()
    fs.writeFileSync(this.path.ypg, HJSON.rt.stringify(this.conf.ypg))
    fs.utimesSync(this.path.ypg, this.mtime, this.mtime)
    this.watch()
    console.log(`Updated \`${this.path.ypg}\``)
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
    console.log(`Updated \`${this.path.ygg}\` and restarted Yggdrasil`)
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
