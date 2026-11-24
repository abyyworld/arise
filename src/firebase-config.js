// The web config of your Firebase project (Firebase console, Project settings, Your apps, Web app).
// These values are not secret: the database rules in firestore.rules decide who can read what.
// Set it to null to hide accounts and sync; the app then works on each device only.
// (No measurementId: that is for Google Analytics, which the app doesn't use.)
export const FIREBASE = {
  apiKey: 'AIzaSyDV_tfFWhiEzkQMb9Fg6x1pSuNHq_J-bxg',
  authDomain: 'arise-a7349.firebaseapp.com',
  projectId: 'arise-a7349',
  storageBucket: 'arise-a7349.firebasestorage.app',
  messagingSenderId: '539982857665',
  appId: '1:539982857665:web:e58084356bffa686625b40',
};

// Sign in with Google (account.ts, signin-google.ts): the Web client ID that Firebase made for
// its Google sign-in (Firebase console, Authentication, Sign-in method, Google, Web SDK
// configuration), with https://abyyworld.github.io/arise/ among its redirect addresses in Google
// Cloud (APIs & Services, Credentials). '' hides it. Not a secret: it only names the app. Web only:
// the phone apps sign in with email and password.
export const SIGN_IN_WITH = { google: '539982857665-kcaulqo1jpg84hq35o26oosve6c2vcd1.apps.googleusercontent.com' };
