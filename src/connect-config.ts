// The accounts people can link on the Connect screen and in Settings, Your life, Accounts
// (src/connect/).
//
// Google and Microsoft need the owner to register Arise with them once (docs/LAUNCH.md, "Turning
// on linked accounts"). Until a client ID is here, they show "Coming soon". A client ID isn't a
// secret: it only names the app, and each sign-in only works back on Arise's own address.
//
// Steam and PlayStation need nothing here: each person brings their own key or sign-in code.

export const GOOGLE = {
  // A "Web application" OAuth client, like 1234-abc.apps.googleusercontent.com.
  clientId: '539982857665-kcaulqo1jpg84hq35o26oosve6c2vcd1.apps.googleusercontent.com',
  // The Google app is published, but Google hasn't checked its calendar, mail and Drive access
  // yet: Google shows a warning first, and up to 100 people can connect until it's checked. The
  // app says so when they connect.
  testing: true,
};

export const MICROSOFT = {
  // The "Application (client) ID" of the Azure app registration.
  clientId: '',
  // 'common': work, school and personal Microsoft accounts (Outlook.com, Hotmail, Live).
  tenant: 'common',
};
