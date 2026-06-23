const express = require("express");
const app = express();
const port = 5000;
const cors = require("cors");
require("dotenv").config();

app.use(cors());
app.use(express.json());

const { ObjectId, MongoClient, ServerApiVersion } = require("mongodb");

app.get("/", (req, res) => {
  res.send("Hello from bangladesh!");
});

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const database = client.db("BiblioDrop_db");
    const addBooksCollection = database.collection("books");
    const usersCollection = database.collection("users");
    const deliveriesCollection = database.collection("deliveries");
    const reviewsCollection = database.collection("reviews");

    // home 6 card show
    app.get("/api/featured", async (req, res) => {
      const result = await addBooksCollection.find().limit(6).toArray();
      res.json(result);
    });

    // Get all books with search, filter and sort
    app.get("/api/books", async (req, res) => {
      try {
        const { search, category, status, sortBy, order } = req.query;

        let query = {};

        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { author: { $regex: search, $options: "i" } },
          ];
        }

        if (category) query.category = category;
        if (status) query.status = status;

        let sortOption = {};
        if (sortBy) sortOption[sortBy] = order === "desc" ? -1 : 1;

        const books = await addBooksCollection.find(query).sort(sortOption).toArray();

        res.status(200).send({ success: true, total: books.length, data: books });
      } catch (error) {
        res.status(500).send({ success: false, message: "Failed to load books", error: error.message });
      }
    });

    // book details
    app.get("/api/books/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid Book ID format" });
        }

        const result = await addBooksCollection.findOne({ _id: new ObjectId(id) });

        if (!result) {
          return res.status(404).send({ message: "Book not found" });
        }

        res.send(result);
      } catch (error) {
        console.error("Error fetching book details:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // post book
    app.post("/api/books", async (req, res) => {
      const book = req.body;
      const result = await addBooksCollection.insertOne(book);
      res.send(result);
    });

    // delete book
    app.delete("/api/books/:id", async (req, res) => {
      try {
        const result = await addBooksCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
      } catch (error) {
        res.status(500).send({ success: false, message: "Failed to delete book", error: error.message });
      }
    });

    // unpublish book
    app.patch("/api/books/unpublish/:id", async (req, res) => {
      const result = await addBooksCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: "Unpublished" } }
      );
      res.send(result);
    });

    // edit book
    app.patch("/api/books/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ success: false, message: "Invalid Book ID format" });
        }

        const updateData = { ...req.body };
        delete updateData._id;

        const result = await addBooksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ success: false, message: "Book not found" });
        }

        res.send({ success: true, message: "Book updated successfully", result });
      } catch (error) {
        console.error("Update Error:", error);
        res.status(500).send({ success: false, message: "Internal Server Error" });
      }
    });

    // delete user (admin only)
    app.delete("/api/users/:id", async (req, res) => {
      try {
        const { id } = req.params;

        let result;
        if (ObjectId.isValid(id)) {
          result = await usersCollection.deleteOne({ _id: new ObjectId(id) });
        }
        if (!result || result.deletedCount === 0) {
          result = await usersCollection.deleteOne({ id: id });
        }
        if (result.deletedCount === 0) return res.status(404).send({ message: "User not found" });

        res.send({ success: true, message: "User deleted" });
      } catch (error) {
        console.error("Failed to delete user:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // User Dashboard - Overview (total books read, pending deliveries, total spent, charts)
    app.get("/api/dashboard/user/:userId", async (req, res) => {
      try {
        const { userId } = req.params;
        const userObjectId = ObjectId.isValid(userId) ? new ObjectId(userId) : null;

        // Total books read (delivered or returned)
        const booksRead = await deliveriesCollection.countDocuments({
          $or: [{ userId: userId }, { userId: userObjectId }],
          status: { $in: ["Delivered", "Returned"] }
        });

        // Pending deliveries count
        const pendingDeliveries = await deliveriesCollection.countDocuments({
          $or: [{ userId: userId }, { userId: userObjectId }],
          status: "Pending"
        });

        // Total delivery fees spent
        const spentResult = await deliveriesCollection.aggregate([
          { $match: { $or: [{ userId: userId }, { userId: userObjectId }] } },
          { $group: { _id: null, totalSpent: { $sum: "$deliveryFee" } } }
        ]).toArray();
        const totalSpent = spentResult[0]?.totalSpent || 0;

        // Reading stats for chart (books per month)
        const readingChart = await deliveriesCollection.aggregate([
          { $match: { $or: [{ userId: userId }, { userId: userObjectId }], status: "Delivered" } },
          { $group: { _id: { $month: "$requestDate" }, count: { $sum: 1 } } },
          { $sort: { "_id": 1 } },
          { $project: { month: "$_id", count: 1, _id: 0 } }
        ]).toArray();

        // Delivery status chart
        const deliveryChart = await deliveriesCollection.aggregate([
          { $match: { $or: [{ userId: userId }, { userId: userObjectId }] } },
          { $group: { _id: "$status", count: { $sum: 1 } } },
          { $project: { status: "$_id", count: 1, _id: 0 } }
        ]).toArray();

        res.send({ booksRead, pendingDeliveries, totalSpent, readingChart, deliveryChart });
      } catch (error) {
        console.error("Failed to fetch user dashboard:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // User Dashboard - Delivery History
    app.get("/api/dashboard/user/:userId/deliveries", async (req, res) => {
      try {
        const { userId } = req.params;
        const userObjectId = ObjectId.isValid(userId) ? new ObjectId(userId) : null;

        const deliveries = await deliveriesCollection.find({
          $or: [{ userId: userId }, { userId: userObjectId }]
        }).sort({ requestDate: -1 }).toArray();

        // Populate book titles
        const results = await Promise.all(deliveries.map(async (delivery) => {
          const book = await addBooksCollection.findOne({ _id: new ObjectId(delivery.bookId) });
          return {
            bookTitle: book?.title || "Unknown Book",
            deliveryFee: delivery.deliveryFee,
            requestDate: delivery.requestDate,
            status: delivery.status
          };
        }));

        res.send(results);
      } catch (error) {
        console.error("Failed to fetch delivery history:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // User Dashboard - My Reading List (delivered or returned books)
    app.get("/api/dashboard/user/:userId/reading-list", async (req, res) => {
      try {
        const { userId } = req.params;
        const userObjectId = ObjectId.isValid(userId) ? new ObjectId(userId) : null;

        const deliveries = await deliveriesCollection.find({
          $or: [{ userId: userId }, { userId: userObjectId }],
          status: { $in: ["Delivered", "Returned"] }
        }).toArray();

        const bookIds = deliveries.map(d => new ObjectId(d.bookId));
        const books = await addBooksCollection.find({ _id: { $in: bookIds } }).toArray();

        res.send(books);
      } catch (error) {
        console.error("Failed to fetch reading list:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // User Dashboard - My Reviews (list all reviews by user)
    app.get("/api/dashboard/user/:userId/reviews", async (req, res) => {
      try {
        const { userId } = req.params;
        const userObjectId = ObjectId.isValid(userId) ? new ObjectId(userId) : null;

        const reviews = await reviewsCollection.find({
          $or: [{ userId: userId }, { userId: userObjectId }]
        }).sort({ createdAt: -1 }).toArray();

        // Populate book titles
        const results = await Promise.all(reviews.map(async (review) => {
          const book = await addBooksCollection.findOne({ _id: new ObjectId(review.bookId) });
          return { ...review, bookTitle: book?.title || "Unknown Book" };
        }));

        res.send(results);
      } catch (error) {
        console.error("Failed to fetch reviews:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // User Dashboard - Edit review
    app.put("/api/dashboard/user/:userId/reviews/:reviewId", async (req, res) => {
      try {
        const { reviewId } = req.params;
        const { comment, rating } = req.body;

        const result = await reviewsCollection.updateOne(
          { _id: new ObjectId(reviewId) },
          { $set: { comment, rating, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Review not found" });
        }

        res.send({ success: true, message: "Review updated successfully" });
      } catch (error) {
        console.error("Failed to update review:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // User Dashboard - Delete review
    app.delete("/api/dashboard/user/:userId/reviews/:reviewId", async (req, res) => {
      try {
        const { reviewId } = req.params;
        const result = await reviewsCollection.deleteOne({ _id: new ObjectId(reviewId) });

        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "Review not found" });
        }

        res.send({ success: true, message: "Review deleted successfully" });
      } catch (error) {
        console.error("Failed to delete review:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // admin stats
    app.get("/api/admin/stats", async (req, res) => {
      try {
        const totalUsers = await usersCollection.countDocuments();
        const totalBooks = await addBooksCollection.countDocuments();
        const totalDeliveries = await deliveriesCollection.countDocuments();

        const revenueResult = await deliveriesCollection.aggregate([
          { $group: { _id: null, totalRevenue: { $sum: "$deliveryFee" } } }
        ]).toArray();
        const totalRevenue = revenueResult[0]?.totalRevenue || 0;

        const categoryData = await addBooksCollection.aggregate([
          { $group: { _id: "$category", value: { $sum: 1 } } },
          { $project: { _id: 0, name: "$_id", value: 1 } }
        ]).toArray();

        res.send({ totalUsers, totalBooks, totalDeliveries, totalRevenue, categoryData });
      } catch (error) {
        console.error("Failed to fetch admin stats:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // await client.close();
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
