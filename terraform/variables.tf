variable "aws_region" {
  default = "eu-central-1"
}

variable "node_count" {
  description = "Number of Besu validator nodes"
  type        = number
  default     = 4
}

variable "besu_instance_type" {
  default = "t3.small"
}

variable "runner_instance_type" {
  default = "t3.small"
}

variable "key_name" {
  description = "AWS SSH key pair name"
  type        = string
}

variable "project_name" {
  default = "dvre-validation"
}
