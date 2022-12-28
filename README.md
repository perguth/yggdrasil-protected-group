# yggdrasil-protected-group

> Sync Yggdrasil `Peers`, `AllowedPublicKeys` and whitelist IPs via UFW

```
# Install NodeJS
sudo apt install -y nodejs

# Fix Yggdrasil interface name
sudo sed -i 's/IfName: auto/IfName: ygg0/g' /etc/yggdrasil.conf

# Install and setup UFW
sudo apt install -y ufw
sudo ufw allow ssh
sudo ufw enable

# Setup systemd service
bash -c "$(curl -fsSL https://raw.githubusercontent.com/perguth/yggdrasil-protected-group/master/setup.sh)"
```
