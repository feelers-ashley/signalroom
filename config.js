/*
  Signal Room — config
  1. Paste the firebaseConfig object from your Firebase project below
     (Project settings → General → Your apps → Web app → SDK setup and configuration → Config).
  2. Leave it as it is to try Signal Room in LOCAL MODE (tabs on one computer only).
*/
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyA2WWfOjkzHoDPO2A5T5Y7CE1pHhimRYaM",
  authDomain: "signalroom-c4c48.firebaseapp.com",
  databaseURL:
    "https://signalroom-c4c48-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "signalroom-c4c48",
  storageBucket: "signalroom-c4c48.firebasestorage.app",
  messagingSenderId: "934108614640",
  appId: "1:934108614640:web:6fb057d17794c733c35735",
};

// Everyone who opens the same page joins this room on the database.
window.ROOM = "signal-room";
