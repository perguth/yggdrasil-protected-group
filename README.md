# Yggdrasil Protected Group

> Sync [Yggdrasil](https://yggdrasil-network.github.io/) `Peers`, `AllowedPublicKeys` and whitelist IPs via [UFW](https://manpages.ubuntu.com/manpages/bionic/en/man8/ufw.8.html)

- Adds a new config file under `/etc/yggdrasil-protected-group.conf`
- Watches the new config file for changes
- Automatically syncs changes with the group
- Automatically updates and restarts Yggdrasil
- Whitelists group members for access to local ports via UFW
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

- The same `SharedSecret` must be used for all group members
- After changing the `SharedSecret` the service must be restarted:  
  `sudo service yggdrasil-protected-group restart`
-  All other properties are automatically synced
- Comments in `GroupShared` and `LocalOnly` are synced as well
