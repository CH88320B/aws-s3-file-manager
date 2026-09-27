terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = { Project = var.name, ManagedBy = "terraform" }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  description = "Prefix for all resources"
  type        = string
  default     = "file-manager"
}

variable "allowed_origins" {
  description = "Browser origins allowed to upload directly to S3"
  type        = list(string)
  default     = ["http://localhost:5173"]
}

data "aws_caller_identity" "current" {}

# ----------------------------------------------------------------------------- bucket

resource "aws_s3_bucket" "files" {
  bucket = "${var.name}-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Browsers POST straight to S3 with the pre-signed form, so CORS must allow it.
resource "aws_s3_bucket_cors_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  cors_rule {
    allowed_methods = ["POST", "GET"]
    allowed_origins = var.allowed_origins
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "files" {
  bucket = aws_s3_bucket.files.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  rule {
    id     = "originals-to-infrequent-access"
    status = "Enabled"
    filter {
      prefix = "uploads/"
    }
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
  }
}

# ----------------------------------------------------------------------------- CloudFront (thumbnails only)

resource "aws_cloudfront_origin_access_control" "files" {
  name                              = "${var.name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "thumbnails" {
  enabled         = true
  comment         = "${var.name} thumbnails"
  price_class     = "PriceClass_100"
  is_ipv6_enabled = true

  origin {
    domain_name              = aws_s3_bucket.files.bucket_regional_domain_name
    origin_id                = "s3-files"
    origin_access_control_id = aws_cloudfront_origin_access_control.files.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-files"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# Only thumbnails are readable through CloudFront; originals stay private (pre-signed URLs only).
data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "CloudFrontReadThumbnails"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.files.arn}/thumbnails/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.thumbnails.arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.files.arn,
      "${aws_s3_bucket.files.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "files" {
  bucket     = aws_s3_bucket.files.id
  policy     = data.aws_iam_policy_document.bucket.json
  depends_on = [aws_s3_bucket_public_access_block.files]
}

# ----------------------------------------------------------------------------- application IAM

data "aws_iam_policy_document" "app" {
  statement {
    sid       = "ObjectAccess"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.files.arn}/uploads/*", "${aws_s3_bucket.files.arn}/thumbnails/*"]
  }
}

resource "aws_iam_policy" "app" {
  name        = "${var.name}-app"
  description = "Least-privilege access for the file manager service"
  policy      = data.aws_iam_policy_document.app.json
}

output "bucket" {
  value = aws_s3_bucket.files.bucket
}

output "cloudfront_url" {
  value = "https://${aws_cloudfront_distribution.thumbnails.domain_name}"
}

output "app_policy_arn" {
  description = "Attach to the role your service runs as (ECS task role, EC2 instance profile, ...)"
  value       = aws_iam_policy.app.arn
}
