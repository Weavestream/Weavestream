# ─────────────────────────────────────────────────────────────────────────
# Weavestream — key generator (Windows PowerShell 5.1+ / PowerShell 7+)
#
# Writes fresh random secrets to stdout in KEY=value form, ready to
# append to your .env file. Uses the .NET RandomNumberGenerator — no
# external tooling required.
#
#   .\scripts\keygen.ps1 | Out-File -Append -Encoding ascii .env
# ─────────────────────────────────────────────────────────────────────────

function New-Key {
    param(
        [Parameter(Mandatory = $true)] [int] $Bytes,
        [switch] $UrlSafe,
        [switch] $Hex
    )

    $buffer = New-Object byte[] $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)

    if ($Hex) {
        return -join ($buffer | ForEach-Object { $_.ToString("x2") })
    }

    $s = [Convert]::ToBase64String($buffer)
    if ($UrlSafe) {
        $s = $s -replace '\+', '-' -replace '/', '_' -replace '=', ''
    }
    return $s
}

# 32-byte signing keys — standard base64.
"JWT_SIGNING_KEY=$(New-Key 32)"
"MFA_ENCRYPTION_KEY=$(New-Key 32)"
"PASSWORD_ENCRYPTION_KEY=$(New-Key 32)"
"COOKIE_SIGNING_KEY=$(New-Key 32)"
"CSRF_SIGNING_KEY=$(New-Key 32)"

# Passwords embedded in DATABASE_URL / REDIS_URL — URL-safe base64.
"POSTGRES_PASSWORD=$(New-Key 24 -UrlSafe)"
"REDIS_PASSWORD=$(New-Key 24 -UrlSafe)"

# MinIO — hex access key, URL-safe secret.
"MINIO_ACCESS_KEY=$(New-Key 12 -Hex)"
"MINIO_SECRET_KEY=$(New-Key 24 -UrlSafe)"
