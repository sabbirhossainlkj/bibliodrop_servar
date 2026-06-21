const { ObjectId } = require("mongodb");
const express = require("express");
const app = express();
const port = 5000;
const cors = require("cors");
require("dotenv").config();

app.use(cors());
app.use(express.json());

const { MongoClient, ServerApiVersion } = require("mongodb");

app.get("/", (req, res) => {
  res.send("Hello from bangladesh!");
});

const uri = process.env.MONGODB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const database = client.db("BiblioDrop_db");
    const addBooksCollection = database.collection("books");

    // libararian books data
    // book details page

    app.get("/api/books/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid Book ID format" });
        }

        const query = { _id: new ObjectId(id) };
        const result = await addBooksCollection.findOne(query);

        // Jodi boi ti database e na paoya jay
        if (!result) {
          return res.status(404).send({ message: "Book not found" });
        }

        res.send(result);
      } catch (error) {
        console.error("Error fetching book details:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // get all books
    app.get("/api/books", async (req, res) => {
      try {
        const result = await addBooksCollection.find().toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to fetch books",
          error: error.message,
        });
      }
    });

    // post book data
    app.post("/api/books", async (req, res) => {
      const book = req.body;
      const result = await addBooksCollection.insertOne(book);
      res.send(result);
    });

    // delete book data
    app.delete("/api/books/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const query = {
          _id: new ObjectId(id),
        };

        const result = await addBooksCollection.deleteOne(query);

        res.send(result);
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to delete book",
          error: error.message,
        });
      }
    });

    // edit book data
    const { ObjectId } = require("mongodb");

    app.patch("/api/books/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const updateBook = req.body;

        const result = await addBooksCollection.updateOne(
          {
            _id: new ObjectId(id),
          },
          {
            $set: updateBook,
          },
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to update book",
          error: error.message,
        });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
