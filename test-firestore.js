const {initializeApp,  applicationDefault} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');



async function testFirestore() {
    try {
        initializeApp({
            credential: applicationDefault(),
            projectId: "peacefield-payments-bf7c2",
        });

        const db = getFirestore();

        const snapshot = await db.collection('payments').limit(10).get();

        console.log("firestore read successful!");

        console.log(`Documents found :${snapshot.size}`)

        snapshot.forEach((doc) => {
            console.log(`Document ID: ${doc.id}`);
            console.log("Fields:", JSON.stringify(doc.data(), null, 2));
            console.log("--------------------------------");
        })

    } catch (error) {
        console.error('Firestore read failed:', error);
    }
}

testFirestore();