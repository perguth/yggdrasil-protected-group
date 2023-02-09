# Yggdrasil Protected Group

> Sync [Yggdrasil Network](https://yggdrasil-network.github.io/) `Peers`, `AllowedPublicKeys` and whitelist IPs via [UFW](https://manpages.ubuntu.com/manpages/bionic/en/man8/ufw.8.html).

This script:

- Adds a new config file under `/etc/yggdrasil-protected-group.conf`
- **Watches** the new **config file** for changes
- Automatically **syncs** changes **with** the **group**
- Automatically updates and **restarts Yggdrasil**
- **Whitelists group members** Yggdrasil IPs for access to local ports via UFW
- The properties `Peers` and `AllowedPublicKeys` in `/etc/yggdrasil.conf` will be managed by this service and automatically overriden on changes

## Install

```bash
# Install the systemd service
bash -c "$(curl -fsSL https://raw.githubusercontent.com/perguth/yggdrasil-protected-group/main/setup.sh)"

# Set/copy the `SharedSecret` of the group
sudo nano /etc/yggdrasil-protected-group.conf
# and restart the service if changed
sudo service yggdrasil-protected-group restart

# Now the group is syncing.
# Already whitelisted IPs are shown by:
# $ sudo ufw show added

# Enable the firewall
sudo ufw enable
```

## Usage

Directly edit the [Hjson](https://hjson.github.io/) file:

`/etc/yggdrasil-protected-group.conf`
```
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

## Related

- **[Sync SSH Config](https://github.com/perguth/sync-ssh-config)**
