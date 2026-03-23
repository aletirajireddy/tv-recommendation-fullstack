# Oracle Cloud (OCI) VM Migration & Split Architecture Plan

This document outlines the roadmap, infrastructure requirements, and code changes necessary to migrate the Ultra Scalper Dashboard from a "Local Monolith" (Client + Server + DB on one laptop) to a **Distributed Cloud Architecture** using an Oracle Cloud Infrastructure (OCI) Free Tier VM.

---

## 1. Target Architecture Overview

You have two potential paths for this migration:

### Option 1: The "Split" System (Traditional Cloud)
*   **The Brain (OCI Cloud VM)**: Houses the Node.js/Express Backend and the SQLite Database. It acts as the central hub receiving all market data and serving API requests.
*   **The Scraper (Local Laptop/Browser)**: Your local TradingView tab runs the Tampermonkey scripts, sending POST requests to the new Cloud Backend IP/Domain.

### Option 2: The "Virtual Desktop" System (VM as a Remote Laptop)
*   **The Scraper & Brain (OCI VM)**: The VM acts perfectly like your personal laptop. You install a Linux Desktop Environment, Chromium, and your Tampermonkey/Automa extensions directly on the VM. You log into TradingView inside the VM's browser and leave it running Streams A & B 24/7.
*   **The Tunneling (Tailscale)**: You expose the local Frontend (Port 5173/3000) using Tailscale Funnel just like your current setup. 
*   **The View (External Access)**: From anywhere, you hit your Tailscale public URL (e.g., `https://desktop-c92c19n.tailbf6529.ts.net/`) to access the dashboard. This requires *zero* Nginx or SSL configuration.

### Data Flow Diagram (Target State)
```mermaid
graph TD
    TV_A[TradingView local Tab: Stream A/B]
    TV_W[TradingView Cloud: Stream C]
    
    subgraph OCI Cloud (Ubuntu VM)
        Nginx[Nginx Reverse Proxy & SSL]
        API[Node.js Backend :3000]
        DB[(dashboard_v3.db)]
        StaticFE[Frontend Static Build]
        
        Nginx -- "/api/*" --> API
        Nginx -- "/" --> StaticFE
        API -- "R/W" --> DB
    end
    
    TV_A -- "POST https://api.yourdomain.com/scan-report" --> Nginx
    TV_W -- "POST https://api.yourdomain.com/webhook/smart-levels" --> Nginx
    
    Mobile[Mobile Browser] -- "GET https://dash.yourdomain.com" --> Nginx
    Laptop[Laptop Browser] -- "WebSocket / Socket.IO" --> Nginx
```

---

## 2. Infrastructure Requirements (OCI Setup)

### 2.1 VM Provisioning (Always Free Tier)
*   **Instance**: Compute Instance (VM.Standard.E2.1.Micro or Ampere A1 Compute).
*   **OS**: Ubuntu 22.04 LTS or 24.04 LTS.
*   **Storage**: 50GB Boot Volume (Sufficient for SQLite and Node.js).

### 2.2 Domain & DNS Networking
*   **Requirement**: You must purchase or use an existing domain (e.g., `scalper.com`).
*   **DNS Setup**: Point the domain's A-Record to the Public IP address of the OCI VM.
    *   `dashboard.yourdomain.com` -> UI
    *   `api.yourdomain.com` -> Backend (Optional: can run everything under one domain like `/api` vs `/`).

### 2.3 OCI Security Lists (Firewall)
You MUST manually open ports on the Oracle Cloud Web Console (VCN Security Lists):
*   **Port 80 (TCP)**: HTTP (needed for initial Let's Encrypt SSL generation).
*   **Port 443 (TCP)**: HTTPS (Encrypted traffic).
*   *Note*: Close Port 3000 to the public. All traffic must go through Nginx on Port 443.

---

## 3. Required Codebase Adaptations

To allow the frontend to talk to a remote server, and to ensure security, several code changes are required.

### 3.1 Backend Security (CORS & Auth)
Currently, your backend accepts data from `localhost`.
1.  **CORS Update**: [server/index.js](file:///e:/AI/tv_dashboard/server/index.js) must be updated to allow cross-origin requests from your specific domain (and potentially your Tampermonkey local browser).
    ```javascript
    const corsOptions = {
        origin: ['https://dashboard.yourdomain.com', 'http://localhost:5173'], // Allow prod and local dev
        credentials: true
    };
    app.use(cors(corsOptions));
    ```
2.  **Webhook Authentication**: Currently, webhooks are exposed. If running on the public internet, TradingView payloads MUST include a secret key or header to prevent malicious people from filling your database.
    *   *Implementation*: Add a middleware check for an `x-api-key` header on the `/api/*` POST routes.

### 3.2 Frontend Environment Variables
The React frontend can no longer hardcode `localhost:3000` or rely on the Vite local proxy in production.
1.  **Vite API Bindings**:
    *   Create a `.env` file in the `client/` directory: `VITE_API_BASE_URL=https://dashboard.yourdomain.com`.
    *   Update [useTimeStore.js](file:///e:/AI/tv_dashboard/client/src/store/useTimeStore.js) and `socket.io-client` initialization to use `import.meta.env.VITE_API_BASE_URL` instead of relative `/api` paths.

### 3.3 Tampermonkey Script Migration
Your Tampermonkey scripts ([symbol_market_scanner.js](file:///e:/AI/tv_dashboard/scripts/symbol_market_scanner.js) and [coin_scanner.js](file:///e:/AI/tv_dashboard/scripts/coin_scanner.js)) are currently hardcoded to POST to `http://localhost:3000`.
1.  **Change URLs**: Find all `GM_xmlhttpRequest` calls and update the URL to your new secure cloud domain: `https://dashboard.yourdomain.com/api/scan-report`.

---

## 4. OCI Server Software Stack Deployment

Once the VM is running, you will SSH into it and deploy this stack:

### Step 1: Install Node, Nginx, and PM2
```bash
# Update Server
sudo apt update && sudo apt upgrade -y

# Install Node Version Manager (NVM) and Node v20
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash
nvm install 20

# Install Nginx and PM2
sudo apt install nginx -y
npm install -g pm2
```

### Step 2: Clone & Build
```bash
# Clone your private repo to the VM
git clone [YOUR_GITHUB_REPO] /var/www/tv_dashboard
cd /var/www/tv_dashboard

# Install Backend
cd server && npm install

# Install & Build Frontend Static Files
cd ../client && npm install
npm run build
```

### Step 3: PM2 Process Management
We no longer need PM2 to run the Vite dev server. PM2 only runs the backend. Nginx serves the frontend.
```bash
cd /var/www/tv_dashboard/server
pm2 start index.js --name tv-backend
pm2 save
pm2 startup
```

### Step 4: Configure Nginx (The Proxy & Static Server)
Edit `/etc/nginx/sites-available/default`:
```nginx
server {
    listen 80;
    server_name dashboard.yourdomain.com;

    # Serve the built React App
    root /var/www/tv_dashboard/client/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API requests to Node Backend
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Proxy Socket.IO
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }
}
```

### Step 5: Secure with SSL (Let's Encrypt)
TradingView Webhooks and `GM_xmlhttpRequest` both strongly prefer or require HTTPS.
```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx -y

# Generate SSL Certificate and auto-configure Nginx
sudo certbot --nginx -d dashboard.yourdomain.com
```

---

## 5. Migration Checklist & Phased Rollout

**Phase A: Local Hardening**
- [ ] Refactor React app to use `.env` networking.
- [ ] Implement `x-api-key` validation in Express.js endpoints.
- [ ] Setup cross-environment compatibility in Tampermonkey scripts (allow a UI toggle for "Dev/Local" vs "Prod/Cloud").

**Phase B: Infrastructure Provisioning**
- [ ] Spin up OCI Ubuntu Instance.
- [ ] Configure OCI Virtual Cloud Network (VCN) ingress rules for Ports 80 & 443.
- [ ] Buy a cheap Domain name & configure A-records on Cloudflare/Namecheap.

**Phase C: Deployment**
- [ ] Install Node, PM2, Nginx, Certbot on the OCI VM.
- [ ] Run `npm run build` locally, push code to Git, pull to VM.
- [ ] Link Nginx to PM2 Backend.
- [ ] Migrate local [dashboard_v3.db](file:///e:/AI/tv_dashboard/dashboard_v3.db) database to the cloud via SFTP.

**Phase D: Cutover**
- [ ] Change TradingView Server Webhook URLs.
- [ ] Switch Tampermonkey scripts to Cloud mode.
- [ ] Shut down Tailscale funnel and local PM2.

---

## 6. Option 2: The Virtual Desktop Setup Guide

If you choose **Option 2** (running everything on the VM like a remote laptop), follow this specific roadmap instead of the Nginx/Domain steps above.

### Step 1: VM Provisioning (Resource Intensive)
*   **Instance**: Because compiling React, running SQLite, and rendering a full Chromium browser tab 24/7 is resource-intensive, you should ensure you provision the **Ampere A1 Compute (ARM)** instance in OCI's Free Tier. You can allocate up to 4 OCPUs and 24GB of RAM for free, which is perfect for a headless Chrome setup.

### Step 2: Install Desktop Environment & Remote Access
Connect via SSH and install a lightweight GUI (XFCE) and Remote Desktop protocol:
```bash
sudo apt update && sudo apt upgrade -y
# Install XFCE Desktop
sudo apt install xfce4 xfce4-goodies -y
# Install XRDP for remote viewing
sudo apt install xrdp -y
sudo systemctl enable xrdp
sudo echo xfce4-session >~/.xsession
sudo service xrdp restart
```
*   **Connect**: Open Port 3389 in your OCI Security List. Use Windows Remote Desktop Connection (RDC) to connect to `[VM_PUBLIC_IP]:3389`.

### Step 3: Install Chrome, Node, & Git Inside the VM
Through your new Remote Desktop window, open a Terminal:
```bash
# Install Chromium Browser
sudo apt install chromium-browser -y

# Install Node & PM2
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash
nvm install 20
npm install -g pm2
```

### Step 4: Setup the Ultra Scalper App
```bash
git clone [YOUR_GITHUB_REPO] ~/tv_dashboard
cd ~/tv_dashboard
cd server && npm install
cd ../client && npm install
```
Start the ecosystem locally just like you do now:
```bash
pm2 start ecosystem.config.js
pm2 save
```

### Step 5: Configure TradingView in the VM
1. Open Chromium from the XFCE applications menu.
2. Install **Tampermonkey** and **Automa** from the Chrome Web Store.
3. Import your scripts ([symbol_market_scanner.js](file:///e:/AI/tv_dashboard/scripts/symbol_market_scanner.js), [coin_scanner.js](file:///e:/AI/tv_dashboard/scripts/coin_scanner.js)).
4. Log into TradingView.com.
5. Open your two tabs (Stream A & Stream B) and leave them running continuously.

### Step 6: Expose via Tailscale Funnel
1. Install Tailscale on the OCI VM: `curl -fsSL https://tailscale.com/install.sh | sh`.
2. Authenticate the VM to your Tailscale network: `sudo tailscale up`.
3. Enable the Funnel to expose the React port (which acts as proxy for the backend):
```bash
sudo tailscale serve --bg --https=443 localhost:5173
sudo tailscale funnel 443 on
```
4. **Access It**: You can now access your dashboard from any smartphone or foreign laptop by navigating to the VM's Tailscale domain: `https://[vm-name].tail[xxxxx].ts.net/`.
5. **Webhooks**: Update TradingView alerts to point to `https://[vm-name].tail[xxxxx].ts.net/api/webhook/smart-levels`.

**Summary of Option 2**: This is the fastest, lowest-complexity path to the cloud. You avoid Nginx, Let's Encrypt Certbot, Domain purchasing, and CORS debugging, while gaining the 24/7 uptime benefits of a dedicated server.
