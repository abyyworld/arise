import './native-boot';
import './styles/app.css';
import './styles/arise.css';
import { isShareHash } from './lib/share';
import { isMeHash } from './lib/me';
import { hasAriseHere, isPlanHash } from './lib/plan-link';
import { handleOAuthReturn } from './connect/return';

// A shared goal's link opens only that page (share-view.ts): no intro, no account, nothing kept on
// the device, for someone who never used Arise. So does a me link (what someone shares about
// themselves with an app), to show what's in it. A Google or Microsoft sign-in coming back to the
// pop-up it opened in hands its answer to the app and closes (connect/return.ts). Everything else
// opens the app.
if (isShareHash(location.hash) || isMeHash(location.hash)) import('./share-view');
// A plan someone shared: their page (plan-view.ts) for someone without Arise in this browser;
// with Arise here, the app answers it, and it goes in their calendar (plans-ui.js).
else if (isPlanHash(location.hash) && !hasAriseHere()) import('./plan-view');
else if (!handleOAuthReturn()) import('./app.js');
