param(
    [string]$VmTailnetIp = "YOUR_TAILSCALE_IP", # Replace with your VM's Tailscale IP or Domain
    [string]$VmUser = "ubuntu" # Default user for Ubuntu on Oracle Cloud
)

Write-Host "============================================="
Write-Host "    Ultra Scalper - Cloud Sync Utility"
Write-Host "============================================="

Write-Host "`n[1/3] Pushing Local Code to GitHub..."
git push origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "WARNING: Git push failed or nothing to push. Attempting to continue..." -ForegroundColor Yellow
}

Write-Host "`n[2/3] Triggering Cloud Update & Grooming..."
# Remote commands:
# 1. Pull code
# 2. Ensure .env exists and has the correct APP_ENV/Telegram flags
# 3. Install dependencies if package-lock changed
# 4. Run Telegram diagnostic
# 5. Reload PM2
$remoteCmd = @"
cd ~/tv_dashboard && \
git pull origin main && \
touch server/.env && \
(grep -q 'APP_ENV' server/.env || echo 'APP_ENV=cloud' >> server/.env) && \
(grep -q 'TELEGRAM_ENABLED' server/.env || echo 'TELEGRAM_ENABLED=true' >> server/.env) && \
sed -i 's/^APP_ENV=.*/APP_ENV=cloud/' server/.env && \
sed -i 's/^TELEGRAM_ENABLED=.*/TELEGRAM_ENABLED=true/' server/.env && \
npm install --prefix server && \
Write-Host '--- Running Remote Telegram Diagnostic ---' && \
node server/test_telegram.js && \
pm2 reload ecosystem.config.js
"@

ssh $VmUser@$VmTailnetIp $remoteCmd

Write-Host "`n[3/3] Database Migration?"
Write-Host "Do you want to OVERWRITE the Cloud Database with your Local Database? (y/N)"
$syncDb = Read-Host

if ($syncDb -eq 'y' -or $syncDb -eq 'Y') {
    Write-Host "Halting Cloud Node.js services..."
    ssh $VmUser@$VmTailnetIp 'cd ~/tv_dashboard && pm2 stop ecosystem.config.js'
    
    Write-Host "Uploading Local Database (dashboard_v3.db) to Cloud..."
    scp .\dashboard_v3.db "$VmUser@$VmTailnetIp`:~/tv_dashboard/dashboard_v3.db"
    
    Write-Host "Restarting Cloud Ecosystem..."
    ssh $VmUser@$VmTailnetIp 'cd ~/tv_dashboard && pm2 start ecosystem.config.js'
    Write-Host "Database sync complete!" -ForegroundColor Green
} else {
    Write-Host "Skipped Database Sync (Code only)." -ForegroundColor Cyan
}

Write-Host "`nDeployment Complete! Your Cloud VM is now running the latest version." -ForegroundColor Green
