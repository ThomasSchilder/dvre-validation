if terraform version >/dev/null 2>&1; then
    terraform version
else
    echo "Installing terraform"
    echo "-----------------------------------------------------------------"

    wget -O - https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(grep -oP '(?<=UBUNTU_CODENAME=).*' /etc/os-release || lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
    sudo apt update && sudo apt install terraform
fi

if docker --version >/dev/null 2>&1; then
    docker --version
else
    echo "Installing docker"
    echo "-----------------------------------------------------------------"

    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh ./get-docker.sh
fi

if ansible --version >/dev/null 2>&1; then
    ansible --version
else
    echo "Installing pip"
    sudo apt update
    sudo apt install -y pipx
    pipx ensurepath

    echo "Installing Ansible"
    echo "-----------------------------------------------------------------"
    pipx install --include-deps ansible
fi

if aws --version >/dev/null 2>&1; then
    aws --version
else
    echo "Installing aws-cli"
    echo "-----------------------------------------------------------------"
    apt install unzip
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
    unzip awscliv2.zip
    sudo ./aws/install
fi

if make --version >/dev/null 2>&1; then
    make --version | head -n 1
else
    echo "Installing make" echo "-----------------------------------------------------------------"
    sudo apt update sudo apt install -y make
fi

if node --version >/dev/null 2>&1; then
    node --version
else
    echo "Installing Node.js 22"
    echo "-----------------------------------------------------------------"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
    sudo apt-get install -y nodejs
fi