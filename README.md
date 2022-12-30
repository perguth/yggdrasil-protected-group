# Yggdrasil Protected Group

> Sync [Yggdrasil](https://yggdrasil-network.github.io/) `Peers`, `AllowedPublicKeys` and whitelist IPs via [UFW](https://manpages.ubuntu.com/manpages/bionic/en/man8/ufw.8.html)

When you start building your own Yggdrasil Network cluster you face the dilemma of either not connecting to the wider network or having all of the nodes in your cluster beeing exposed to it. Using this script you can form a private group of nodes that can reach each others ports while keeping them unavailable to the wider network.

Under the hood this script connects the group using [Hyperswarm](https://github.com/holepunchto/hyperswarm) and then uses a group shared secret to intitiate encryption and share changes to the local configuration file of this service with the group.

This service:

- Adds a new config file under `/etc/yggdrasil-protected-group.conf`
- **Watches** the new **config file** for changes
- Automatically **syncs** changes **with** the **group**
- Automatically updates and **restarts Yggdrasil**
- **Whitelists group members** for access to local ports via UFW
- `Peers`, `AllowedPublicKeys` in `/etc/yggdrasil.conf` will be managed by this service and automatically overriden on changes

## Install

```bash
# Install NodeJS
# https://nodejs.org/en/download/package-manager/

# Fix Yggdrasil interface name
sudo sed -i 's/IfName: auto/IfName: ygg0/g' /etc/yggdrasil.conf

# Install and setup UFW
sudo apt install -y ufw
sudo ufw allow ssh

# Install the systemd service
bash -c "$(curl -fsSL https://raw.githubusercontent.com/perguth/yggdrasil-protected-group/master/setup.sh)"

# Set/copy the `SharedSecret` of the group
sudo nano /etc/yggdrasil-protected-group.conf
# and restart the service
sudo service yggdrasil-protected-group restart

# Enable the firewall
sudo ufw enable
```

## Usage

Directly edit the [Hjson](https://hjson.github.io/) file:

```
$ /etc/yggdrasil-protected-group.conf
{
  SharedSecret: ...
  Peers:
  {
    GroupShared: []
    LocalOnly: []
  }
  AllowedPublicKeys:
  {
    GroupShared: []
    LocalOnly: []
  }
}
```

Note that:

- The same `SharedSecret` must be used for all group members
- After changing the `SharedSecret` the service must be restarted:  
  `sudo service yggdrasil-protected-group restart`
-  All other properties are automatically synced
- Comments in `GroupShared` and `LocalOnly` are synced as well
