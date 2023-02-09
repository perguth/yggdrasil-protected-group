#!/bin/sh

NAME=yggdrasil-protected-group

if ! which node > /dev/null; then
  echo Install NodeJS first:
  echo https://nodejs.org/en/download/package-manager/
  exit 1
fi

if sudo which ufw > /dev/null; then
  if ! sudo ufw status | grep -q 'Status: inactive'; then
    echo UFW already enabled! Please reset it first:
    echo $ sudo ufw reset
    exit 1
  fi
fi

# Fix Yggdrasil interface name
sudo sed -i 's/IfName: auto/IfName: ygg0/g' /etc/yggdrasil.conf
sudo service yggdrasil restart

# Stop service
sudo service $NAME stop > /dev/null 2>&1

# Install UFW
sudo apt install -y ufw
# Change from whilelist mode to blacklist mode
sudo ufw default allow
# Generally block incoming requests via Yggdrasil
sudo ufw deny in on ygg0

# Reset swarm state
SWARM=/etc/opt/$NAME/swarm.json
if test -f $SWARM; then
  sudo rm $SWARM
fi

# Clone repository
sudo rm -rf /opt/$NAME
cd /opt
sudo git clone https://github.com/perguth/$NAME.git
cd $NAME
sudo npm i --omit=dev

# Setup service
sudo cp $NAME.service /etc/systemd/system
sudo systemctl daemon-reload
sudo systemctl enable $NAME
sudo systemctl restart $NAME
