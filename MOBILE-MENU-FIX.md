# Mobile Menu Fix for zivraviv.com

## Problem
The hamburger menu dropdown on mobile is being cut off or hidden behind other content.

## Solution
Add custom CSS to fix z-index and positioning of the mobile navigation menu.

## How to Apply (WordPress/Divi)

### Method 1: Divi Theme Options (Recommended)
1. Log into WordPress admin (`https://zivraviv.com/wp-login.php`)
2. Go to **Divi > Theme Options**
3. Scroll to **Custom CSS** section
4. Paste the contents of `mobile-menu-fix.css`
5. Click **Save Changes**

### Method 2: WordPress Customizer
1. Log into WordPress admin
2. Go to **Appearance > Customize**
3. Click **Additional CSS**
4. Paste the contents of `mobile-menu-fix.css`
5. Click **Publish**

### Method 3: Child Theme (Most Permanent)
1. Access your site via FTP/SFTP or file manager
2. Navigate to `/wp-content/themes/Divi-child/` (create child theme if needed)
3. Edit or create `style.css`
4. Append the contents of `mobile-menu-fix.css`
5. Save and clear any caching

## Testing
After applying:
1. Open site on mobile (or Chrome DevTools mobile view at 375px width)
2. Click hamburger menu (☰) icon
3. Verify dropdown appears fully visible below the header
4. Verify menu items are clickable
5. Test on both homepage and /apps/ page

## Files
- `mobile-menu-fix.css` - The CSS fix to apply
- Screenshot showing the issue: [User provided]

## Technical Details
The fix:
- Sets mobile menu bar to `position: relative` with high z-index (99998)
- Sets dropdown to `position: absolute` with even higher z-index (99999)
- Positions dropdown at `top: 100%` (below the header bar)
- Adds shadow for better visibility
- Ensures header doesn't have `overflow: hidden`
- Limits max-height to viewport and adds scroll if needed

## Affected Elements (Divi-specific)
- `.mobile_menu_bar` - The hamburger icon container
- `.et_mobile_nav_menu` - The dropdown navigation menu
- `#main-header`, `#et-top-navigation` - Header elements
