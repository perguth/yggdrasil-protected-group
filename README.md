# yggdrasil-protected-group

```
# Install UFW
sudo apt update && sudo apt install -y ufw
sudo ufw allow ssh
sudo ufw deny in on ygg0
sudo ufw enable

# Setup service
bash -c "$(curl -fsSL https://raw.githubusercontent.com/perguth/yggdrasil-protected-group/master/setup.sh)"
```
