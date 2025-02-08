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

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        // await client.connect();
        // Send a ping to confirm a successful connection
        // await client.db("admin").command({ ping: 1 });
        // console.log("Pinged your deployment. You successfully connected to MongoDB!");



        const foodCollection = client.db('elkano64DB').collection('foods');
        const purchaseCollection = client.db('elkano64DB').collection('purchases');



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



        app.post('/foods', async (req, res) => {
            const newFood = req.body;
            newFood.purchaseCount = 0;
            // console.log('Adding new food', newFood);

            const result = await foodCollection.insertOne(newFood);
            res.send(result);
        });


        app.post('/purchases', async (req, res) => {
            const newPurchase = req.body;
            const date = new Date();
            newPurchase.buyingDate = date.toLocaleString();
            // newPurchase.buyingDate = Date.now();
            // console.log('adding new purchase', newPurchase);

            const insertResult = await purchaseCollection.insertOne(newPurchase);
            const updateResult = await foodCollection.updateOne(
                { name: newPurchase.name },
                { $inc: { purchaseCount: 1 } }
            );

            if (updateResult.matchedCount > 0) {
                res.send({
                    message: 'Purchase added and purchase count updated successfully',
                    insertResult,
                    updateResult
                });
            }

            // const result = await purchaseCollection.insertOne(newPurchase);
            // res.send(result);

        });



        app.put('/foods/:id', async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const options = { upsert: true };
            const updatedFood = {
                $set: req.body
            };

            const result = await foodCollection.updateOne(filter, updatedFood, options);

            res.send(result);
        });


        app.delete('/my-orders/:id', async (req, res) => {
            // console.log('going to delete', req.params.id);
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await purchaseCollection.deleteOne(query);
            res.send(result);
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