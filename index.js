const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.bkfjr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// ---------- booking helpers ----------
// same slots the client shows: 10:00 AM to 9:30 PM, every 30 minutes
const BOOKING_TIME_SLOTS = Array.from({ length: 24 }, (_, i) => {
    const mins = 10 * 60 + i * 30;
    const h = Math.floor(mins / 60);
    const m = String(mins % 60).padStart(2, '0');
    const suffix = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${m} ${suffix}`;
});

const MAX_GUESTS = 10;

// true only for a real calendar date written as YYYY-MM-DD
const isValidDateString = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

// ---------- stock helpers ----------
// reads a field as a number even if it was saved as a string ("50"); missing/invalid -> 0
const numberField = (field) => ({
    $convert: { input: `$${field}`, to: 'int', onError: 0, onNull: 0 },
});

// ---------- notification helpers ----------
// every notification is automatically deleted from the database 7 days after it was created
const NOTIFICATION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const NOTIFICATION_LIST_LIMIT = 100;

async function run() {
    try {

        const foodCollection = client.db('elkano64DB').collection('foods');
        const purchaseCollection = client.db('elkano64DB').collection('purchases');
        const bookingCollection = client.db('elkano64DB').collection('bookings');
        const notificationCollection = client.db('elkano64DB').collection('notifications');

        // ---------- notification indexes ----------
        // 1) TTL index: MongoDB itself deletes a notification 7 days after its createdAt
        // 2) fast lookup of one user's newest notifications
        // (not awaited on purpose, so the routes below are registered immediately)
        notificationCollection
            .createIndex({ createdAt: 1 }, { expireAfterSeconds: NOTIFICATION_LIFETIME_SECONDS })
            .catch((error) => console.error('Notification TTL index error:', error));
        notificationCollection
            .createIndex({ email: 1, createdAt: -1 })
            .catch((error) => console.error('Notification email index error:', error));

        // saves one notification for one user.
        // It NEVER throws: if saving a notification fails, the real action
        // (order, booking, add/update/delete) still succeeds exactly as before.
        const createNotification = async (email, type, title, text) => {
            try {
                const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
                if (!cleanEmail) return;

                await notificationCollection.insertOne({
                    email: cleanEmail,
                    type,
                    title,
                    text,
                    read: false,
                    createdAt: new Date(),
                });
            } catch (error) {
                console.error('createNotification error:', error);
            }
        };


        app.get('/foods', async (req, res) => {
            const cursor = foodCollection.find();
            const result = await cursor.toArray();
            res.send(result);
        });


        app.get('/fixedFoods', async (req, res) => {
            const cursor = foodCollection.find().sort({ purchaseCount: -1 }).limit(6);
            const result = await cursor.toArray();
            res.send(result);
        });


        app.get('/foods/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await foodCollection.findOne(query);
            res.send(result);
        });


        app.get('/searchFoods', async (req, res) => {
            const searchText = req.query.search || '';
            const query = { name: { $regex: searchText, $options: 'i' } };
            const cursor = foodCollection.find(query);
            const result = await cursor.toArray();
            res.send(result);
        });

        app.get('/foods/email/:userEmail', async (req, res) => {
            const email = req.params.userEmail;
            const query = { userEmail: email };
            const result = await foodCollection.find(query).toArray();
            res.send(result);
        });


        app.get('/my-orders', async (req, res) => {
            const email = req.query.email;
            let query = {};
            if (email) {
                query = { buyerEmail: email }
            }

            const cursor = purchaseCollection.find(query);
            const result = await cursor.toArray();
            res.send(result);
        });


        // ---------- GET: one user's table bookings (by email) ----------
        // example: http://localhost:5000/bookings?email=user@example.com
        app.get('/bookings', async (req, res) => {
            try {
                const email = (req.query.email || '').trim().toLowerCase();

                // an email is required, so nobody can list every user's bookings
                if (!email) {
                    return res.status(400).send({ message: 'Email query is required. Example: /bookings?email=user@example.com' });
                }

                const result = await bookingCollection
                    .find({ email })
                    .sort({ createdAt: -1 }) // newest booking first
                    .toArray();

                res.send(result);
            } catch (error) {
                console.error('GET /bookings error:', error);
                res.status(500).send({ message: 'Failed to load bookings.' });
            }
        });


        // ---------- GET: one user's notifications (by email) ----------
        // example: http://localhost:5000/notifications?email=user@example.com
        // only the last 7 days exist, older ones are removed automatically by the TTL index
        app.get('/notifications', async (req, res) => {
            try {
                const email = (req.query.email || '').trim().toLowerCase();

                // an email is required, so nobody can list every user's notifications
                if (!email) {
                    return res.status(400).send({ message: 'Email query is required. Example: /notifications?email=user@example.com' });
                }

                const result = await notificationCollection
                    .find({ email })
                    .sort({ createdAt: -1 }) // newest notification first
                    .limit(NOTIFICATION_LIST_LIMIT)
                    .toArray();

                res.send(result);
            } catch (error) {
                console.error('GET /notifications error:', error);
                res.status(500).send({ message: 'Failed to load notifications.' });
            }
        });



        app.post('/foods', async (req, res) => {
            const newFood = req.body;
            newFood.purchaseCount = 0;
            const result = await foodCollection.insertOne(newFood);

            // notify the user who added the food
            if (result.acknowledged) {
                await createNotification(
                    newFood.userEmail,
                    'food_added',
                    'Food Added',
                    `You added "${newFood.name || 'a new food'}" to the menu.`
                );
            }

            res.send(result);
        });


        // ---------- POST: purchase a food (reduces stock + increases purchaseCount) ----------
        app.post('/purchases', async (req, res) => {
            try {
                const newPurchase = req.body || {};
                const qty = Number(newPurchase.numQuantity);

                // 1) quantity must be a whole number, at least 1
                if (!Number.isInteger(qty) || qty < 1) {
                    return res.status(400).send({ message: 'Invalid quantity.' });
                }

                // 2) which food? prefer the exact _id, fall back to the name (old behaviour)
                let foodFilter;
                if (newPurchase.foodId && ObjectId.isValid(newPurchase.foodId)) {
                    foodFilter = { _id: new ObjectId(newPurchase.foodId) };
                } else if (newPurchase.name) {
                    foodFilter = { name: newPurchase.name };
                } else {
                    return res.status(400).send({ message: 'Food is required.' });
                }

                // 3) ATOMIC update: only matches if enough stock is left, and in the
                //    same single operation subtracts the stock and adds to purchaseCount.
                //    Two users buying at the same time can never oversell.
                const updateResult = await foodCollection.updateOne(
                    {
                        ...foodFilter,
                        $expr: { $gte: [numberField('availableQuantity'), qty] },
                    },
                    [
                        {
                            $set: {
                                availableQuantity: { $subtract: [numberField('availableQuantity'), qty] },
                                purchaseCount: { $add: [numberField('purchaseCount'), qty] },
                            },
                        },
                    ]
                );

                // 4) nothing matched -> food missing or not enough stock
                if (updateResult.matchedCount === 0) {
                    const foodExists = await foodCollection.findOne(foodFilter, { projection: { _id: 1 } });
                    if (!foodExists) {
                        return res.status(404).send({ message: 'Food not found.' });
                    }
                    return res.status(409).send({ message: 'Sorry, not enough quantity available. Someone may have just bought it.' });
                }

                // 5) stock reserved -> save the order
                newPurchase.buyingDate = new Date().toLocaleString();

                let insertResult;
                try {
                    insertResult = await purchaseCollection.insertOne(newPurchase);
                } catch (insertError) {
                    // saving the order failed -> give the stock back so nothing is lost
                    await foodCollection.updateOne(foodFilter, {
                        $inc: { availableQuantity: qty, purchaseCount: -qty },
                    });
                    throw insertError;
                }

                // 6) order saved -> notify the buyer
                await createNotification(
                    newPurchase.buyerEmail,
                    'order_created',
                    'Order Placed Successfully',
                    `You ordered ${qty} x ${newPurchase.name || 'a food item'}.`
                );

                res.send({
                    message: 'Purchase added, available quantity and purchase count updated successfully',
                    insertResult,
                    updateResult,
                });
            } catch (error) {
                console.error('POST /purchases error:', error);
                res.status(500).send({ message: 'Failed to place the order. Please try again.' });
            }
        });


        // ---------- POST: book a table ----------
        app.post('/bookings', async (req, res) => {
            try {
                const { name, email, date, time, guests } = req.body || {};

                const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
                const guestCount = Number(guests);

                // 1) required fields
                if (!cleanEmail || !date || !time || guests === undefined || guests === '') {
                    return res.status(400).send({ message: 'Email, date, time and guests are required.' });
                }

                // 2) date must be a real date and not in the past
                //    (one day of tolerance so users in other time zones are never wrongly rejected)
                if (!isValidDateString(date)) {
                    return res.status(400).send({ message: 'Please provide a valid date.' });
                }
                const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
                if (date < yesterday) {
                    return res.status(400).send({ message: 'You cannot book a table for a past date.' });
                }

                // 3) time must be one of our real slots
                if (!BOOKING_TIME_SLOTS.includes(time)) {
                    return res.status(400).send({ message: 'Please choose a valid time slot.' });
                }

                // 4) guests must be a whole number from 1 to 10
                if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > MAX_GUESTS) {
                    return res.status(400).send({ message: `Guests must be between 1 and ${MAX_GUESTS}.` });
                }

                // 5) the same user cannot book the same date + time twice
                const alreadyBooked = await bookingCollection.findOne({ email: cleanEmail, date, time });
                if (alreadyBooked) {
                    return res.status(409).send({ message: 'You already have a booking for this date and time.' });
                }

                const newBooking = {
                    name: typeof name === 'string' ? name.trim() : '',
                    email: cleanEmail,
                    date,
                    time,
                    guests: guestCount,
                    status: 'confirmed',
                    createdAt: new Date(),
                };

                const result = await bookingCollection.insertOne(newBooking);

                // booking saved -> notify the user
                await createNotification(
                    cleanEmail,
                    'booking_created',
                    'Table Booked Successfully',
                    `Your table for ${guestCount} ${guestCount === 1 ? 'guest' : 'guests'} on ${date} at ${time} is confirmed.`
                );

                res.status(201).send({ message: 'Table booked successfully.', insertedId: result.insertedId });
            } catch (error) {
                console.error('POST /bookings error:', error);
                res.status(500).send({ message: 'Failed to book the table. Please try again.' });
            }
        });



        app.put('/foods/:id', async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const options = { upsert: true };
            const updatedFood = {
                $set: req.body
            };

            // look the food up first, only to know its owner + name for the notification
            let existingFood = null;
            try {
                existingFood = await foodCollection.findOne(filter, { projection: { userEmail: 1, name: 1 } });
            } catch (lookupError) {
                console.error('PUT /foods lookup error:', lookupError);
            }

            const result = await foodCollection.updateOne(filter, updatedFood, options);

            // food updated -> notify its owner
            if (result.matchedCount > 0) {
                await createNotification(
                    (existingFood && existingFood.userEmail) || (req.body && req.body.userEmail),
                    'food_updated',
                    'Food Updated',
                    `Your food "${(req.body && req.body.name) || (existingFood && existingFood.name) || 'item'}" was updated successfully.`
                );
            }

            res.send(result);
        });


        app.delete('/my-orders/:id', async (req, res) => {
            // console.log('going to delete', req.params.id);
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };

            // read the order before it disappears, only to know its buyer + food name
            let order = null;
            try {
                order = await purchaseCollection.findOne(query, { projection: { buyerEmail: 1, name: 1 } });
            } catch (lookupError) {
                console.error('DELETE /my-orders lookup error:', lookupError);
            }

            const result = await purchaseCollection.deleteOne(query);

            // order deleted -> notify the buyer
            if (result.deletedCount > 0 && order) {
                await createNotification(
                    order.buyerEmail,
                    'order_deleted',
                    'Order Deleted',
                    `Your order for ${order.name || 'a food item'} was deleted.`
                );
            }

            res.send(result);
        });


        // ---------- DELETE: remove one booking of a specific user ----------
        // example: DELETE http://localhost:5000/bookings/<bookingId>?email=user@example.com
        app.delete('/bookings/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const email = (req.query.email || '').trim().toLowerCase();

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: 'Invalid booking id.' });
                }
                if (!email) {
                    return res.status(400).send({ message: 'Email query is required.' });
                }

                const bookingQuery = { _id: new ObjectId(id), email };

                // read the booking before it disappears, only to describe it in the notification
                let booking = null;
                try {
                    booking = await bookingCollection.findOne(bookingQuery, { projection: { date: 1, time: 1, guests: 1 } });
                } catch (lookupError) {
                    console.error('DELETE /bookings lookup error:', lookupError);
                }

                // both id AND email must match, so a user can only delete their own booking
                const result = await bookingCollection.deleteOne(bookingQuery);

                if (result.deletedCount === 0) {
                    return res.status(404).send({ message: 'Booking not found for this user.' });
                }

                // booking deleted -> notify the user
                await createNotification(
                    email,
                    'booking_deleted',
                    'Booking Deleted',
                    booking
                        ? `Your table booking on ${booking.date} at ${booking.time} was deleted.`
                        : 'Your table booking was deleted.'
                );

                res.send({ message: 'Booking deleted successfully.', deletedCount: result.deletedCount });
            } catch (error) {
                console.error('DELETE /bookings error:', error);
                res.status(500).send({ message: 'Failed to delete the booking.' });
            }
        });


        // ---------- PATCH: mark ALL of one user's notifications as read ----------
        // example: PATCH http://localhost:5000/notifications/read-all?email=user@example.com
        app.patch('/notifications/read-all', async (req, res) => {
            try {
                const email = (req.query.email || '').trim().toLowerCase();

                if (!email) {
                    return res.status(400).send({ message: 'Email query is required.' });
                }

                // only this user's unread notifications are touched
                const result = await notificationCollection.updateMany(
                    { email, read: false },
                    { $set: { read: true } }
                );

                res.send({ message: 'All notifications marked as read.', modifiedCount: result.modifiedCount });
            } catch (error) {
                console.error('PATCH /notifications/read-all error:', error);
                res.status(500).send({ message: 'Failed to mark notifications as read.' });
            }
        });


    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);



app.get('/', (req, res) => {
    res.send('elkano64 server is running')
});


app.listen(port, () => {
    console.log(`elkano64 server is running on PORT: ${port}`)
});