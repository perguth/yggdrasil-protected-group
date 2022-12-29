# Yggdrasil Protected Group

> Sync [Yggdrasil](https://yggdrasil-network.github.io/) `Peers`, `AllowedPublicKeys` and whitelist IPs via UFW

- Adds a new config file under `/etc/yggdrasil-protected-group.conf`
- Watches the new config file for changes
- Automatically syncs changes with the group
- Automatically updates and restarts Yggdrasil
- Whitelists all group members for access to local ports
- `Peers`, `AllowedPublicKeys` in `/etc/yggdrasil.conf` will be managed by this service and automatically overriden on changes

## Install

```bash
# Install NodeJS
sudo apt install -y nodejs

# Fix Yggdrasil interface name
sudo sed -i 's/IfName: auto/IfName: ygg0/g' /etc/yggdrasil.conf

# Install and setup UFW
sudo apt install -y ufw
sudo ufw allow ssh
sudo ufw enable

# Setup the systemd service
bash -c "$(curl -fsSL https://raw.githubusercontent.com/perguth/yggdrasil-protected-group/master/setup.sh)"
```

## Usage

Directly edit:

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
