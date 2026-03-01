# Apply Mobile Menu Fix - Quick Guide

## What This Does
Automatically applies the mobile menu CSS fix to your WordPress site using the AppSpotlight publisher's WordPress API integration.

## Prerequisites

### 1. WordPress Application Password
You need a WordPress Application Password (not your regular password):

1. Log into WordPress at `https://zivraviv.com/wp-admin`
2. Go to **Users → Profile** (or **Users → Your Profile**)
3. Scroll down to **Application Passwords**
4. Enter a name (e.g., "AppSpotlight")
5. Click **Add New Application Password**
6. **Copy the generated password** (shows once only)

### 2. Create .env File
Create `/root/.openclaw/workspace/appspotlight/.env`:

```bash
# WordPress Credentials
WP_BASE_URL=https://zivraviv.com
WP_USERNAME=your_wp_username
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx

# Other required vars (already configured elsewhere)
CLAUDE_API_KEY=<your_key>
GITHUB_TOKEN=<your_token>
```

Replace:
- `your_wp_username` with your WordPress username
- `xxxx xxxx...` with the Application Password you just created

## Run the Fix

Once credentials are set:

```bash
cd /root/.openclaw/workspace/appspotlight
npx tsx scripts/apply-mobile-menu-fix.ts
```

This will:
1. Read `mobile-menu-fix.css`
2. Check if it's already applied (won't duplicate)
3. Append it to WordPress custom CSS
4. Confirm success

## Verify

1. Open `https://zivraviv.com` on mobile (or Chrome DevTools mobile view at 375px)
2. Click the hamburger menu (☰)
3. Verify dropdown appears fully visible and clickable

## Alternative: Manual Application

If you prefer to apply manually:
1. Copy contents of `mobile-menu-fix.css`
2. Log into WordPress → **Appearance → Customize → Additional CSS**
3. Paste and click **Publish**

## Troubleshooting

### "WordPress API error 401"
- Application Password is incorrect or not set
- Check username matches exactly (case-sensitive)
- Regenerate Application Password if needed

### "custom_css not supported"
- Some themes don't support the settings API
- Use manual method instead (Customizer → Additional CSS)

### Fix not working after application
- Clear WordPress cache (if using caching plugin)
- Clear browser cache
- Check browser console for CSS errors
