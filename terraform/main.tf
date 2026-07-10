provider "aws" {
  region = var.aws_region
}

data "aws_ami" "ubuntu" {
  most_recent = true
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  owners = ["099720109477"]
}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags = { Name = "${var.project_name}" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project_name}" }
}

resource "aws_subnet" "main" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true
  tags = { Name = "${var.project_name}" }
}

resource "aws_route_table" "main" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${var.project_name}" }
}

resource "aws_route_table_association" "main" {
  subnet_id      = aws_subnet.main.id
  route_table_id = aws_route_table.main.id
}

resource "aws_security_group" "besu" {
  name        = "${var.project_name}-besu"
  description = "Besu P2P + RPC"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 30303
    to_port     = 30303
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  ingress {
    from_port   = 30303
    to_port     = 30303
    protocol    = "udp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  ingress {
    from_port   = 8545
    to_port     = 8545
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  ingress {
    from_port   = 8546
    to_port     = 8546
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "runner" {
  name        = "${var.project_name}-runner"
  description = "Benchmark runner"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "ssh" {
  name        = "${var.project_name}-ssh"
  description = "SSH for administration"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "besu" {
  count             = var.node_count
  ami               = data.aws_ami.ubuntu.id
  instance_type     = var.besu_instance_type
  subnet_id         = aws_subnet.main.id
  security_groups   = [aws_security_group.besu.id, aws_security_group.ssh.id]
  key_name          = var.key_name
  private_ip        = "10.0.1.${10 + count.index}"
  tags = {
    Name = "${var.project_name}-besu-${count.index}"
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  connection {
    type        = "ssh"
    user        = "ubuntu"
    private_key = file("~/.ssh/${var.key_name}")
    host        = self.public_ip
  }
}

resource "aws_instance" "runner" {
  ami               = data.aws_ami.ubuntu.id
  instance_type     = var.runner_instance_type
  subnet_id         = aws_subnet.main.id
  security_groups   = [aws_security_group.runner.id]
  key_name          = var.key_name
  private_ip        = "10.0.1.5"
  tags = {
    Name = "${var.project_name}-runner"
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }
}

output "besu_private_ips" {
  value = aws_instance.besu[*].private_ip
}

output "besu_public_ips" {
  value = aws_instance.besu[*].public_ip
}

output "runner_private_ip" {
  value = aws_instance.runner.private_ip
}

output "runner_public_ip" {
  value = aws_instance.runner.public_ip
}
