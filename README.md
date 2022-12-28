# yggdrasil-protected-group

> Sync Yggdrasil `Peers`, `AllowedPublicKeys` and whitelist IPs via UFW

```
# Install NodeJS
sudo apt install -y nodejs

# Install and setup UFW
sudo apt install -y ufw
sudo ufw allow ssh
sudo ufw deny in on ygg0
sudo ufw enable

# Setup systemd service
bash -c "$(curl -fsSL https://raw.githubusercontent.com/perguth/yggdrasil-protected-group/master/setup.sh)"
```
