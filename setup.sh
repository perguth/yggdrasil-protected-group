#/bin/sh

NAME=yggdrasil-protected-group

# Clone repository
cd /opt
sudo git clone https://github.com/perguth/$NAME.git
cd $NAME
sudo npm i

# Setup service
sudo cp $NAME.service /etc/systemd/system
sudo systemctl daemon-reload
sudo systemctl enable $NAME
sudo systemctl start $NAME
