const express = require("express");
const app = express();
const port = 5000;
const cors = require("cors");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
require("dotenv").config();

app.use(cors({ origin: ["http://localhost:3000"], credentials: true }));
app.use(express.json());
app.use(cookieParser());

const { ObjectId, MongoClient, ServerApiVersion } = require("mongodb");

app.post("/api/auth/token", (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).send({ message: "Email required" });
  const token = jwt.sign({ email, role }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.send({ success: true, token });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.send({ success: true });
});

const verifyToken = (req, res, next) => {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).send({ message: "Unauthorized" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).send({ message: "Invalid token" });
  }
};

const verifyAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") return res.status(403).send({ message: "Forbidden" });
  next();
};

const verifyAdminOrInternal = (req, res, next) => {
  if (req.headers["x-internal-secret"] === process.env.INTERNAL_SECRET) return next();
  return verifyToken(req, res, () => verifyAdmin(req, res, next));
};

const verifyLibrarian = (req, res, next) => {
  if (!["admin", "librarian"].includes(req.user?.role)) return res.status(403).send({ message: "Forbidden" });
  next();
};

const verifyLibrarianOrInternal = (req, res, next) => {
  if (req.headers["x-internal-secret"] === process.env.INTERNAL_SECRET) return next();
  return verifyToken(req, res, () => verifyLibrarian(req, res, next));
};

app.get("/", (req, res) => {
  res.send("Server is running smoothly!");
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
    const betterAuthUsersCollection = database.collection("user");
    const deliveriesCollection = database.collection("deliveries");
    const reviewsCollection = database.collection("reviews");

    app.get("/api/featured", async (req, res) => {
      const result = await addBooksCollection.find({ status: "Published" }).limit(6).toArray();
      res.json(result);
    });

    app.get("/api/books", async (req, res) => {
      try {
        const { search, category, status, sortBy, order, librarianEmail, page, limit, minFee, maxFee, available } = req.query;

        let query = {};

        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { author: { $regex: search, $options: "i" } },
          ];
        }

        if (category) query.category = category;
        if (status) query.status = status;
        if (librarianEmail) query.librarianEmail = librarianEmail;

        // Delivery fee range filter
        if (minFee !== undefined || maxFee !== undefined) {
          query.deliveryFee = {};
          if (minFee !== undefined) query.deliveryFee.$gte = Number(minFee);
          if (maxFee !== undefined) query.deliveryFee.$lte = Number(maxFee);
        }

        // Availability filter
        if (available === "true") query.available = true;
        else if (available === "false") query.available = false;

        let sortOption = {};
        if (sortBy) sortOption[sortBy] = order === "desc" ? -1 : 1;

        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(1000, Math.max(1, parseInt(limit) || 9));
        const skip = (pageNum - 1) * limitNum;

        const [totalItems, books] = await Promise.all([
          addBooksCollection.countDocuments(query),
          addBooksCollection.find(query).sort(sortOption).skip(skip).limit(limitNum).toArray(),
        ]);

        res.status(200).send({
          success: true,
          data: books,
          totalItems,
          totalPages: Math.ceil(totalItems / limitNum),
          currentPage: pageNum,
        });
      } catch (error) {
        res.status(500).send({ success: false, message: "Failed to load books", error: error.message });
      }
    });

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

    app.post("/api/books", verifyToken, verifyLibrarian, async (req, res) => {
      const book = req.body;
      const result = await addBooksCollection.insertOne(book);
      res.send(result);
    });

    app.delete("/api/books/:id", verifyLibrarianOrInternal, async (req, res) => {
      try {
        const result = await addBooksCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
      } catch (error) {
        res.status(500).send({ success: false, message: "Failed to delete book", error: error.message });
      }
    });

    app.patch("/api/books/unpublish/:id", verifyLibrarianOrInternal, async (req, res) => {
      const result = await addBooksCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: "Unpublished" } }
      );
      res.send(result);
    });

    app.patch("/api/books/:id", verifyLibrarianOrInternal, async (req, res) => {
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

    app.delete("/api/users/:id", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;

        let result;
        if (ObjectId.isValid(id)) {
          result = await betterAuthUsersCollection.deleteOne({ _id: new ObjectId(id) });
        }
        if (!result || result.deletedCount === 0) {
          result = await betterAuthUsersCollection.deleteOne({ id });
        }
        // Fall back to custom users collection
        if (!result || result.deletedCount === 0) {
          if (ObjectId.isValid(id)) {
            result = await usersCollection.deleteOne({ _id: new ObjectId(id) });
          }
        }
        if (!result || result.deletedCount === 0) {
          result = await usersCollection.deleteOne({ id });
        }
        if (!result || result.deletedCount === 0) return res.status(404).send({ message: "User not found" });

        res.send({ success: true, message: "User deleted" });
      } catch (error) {
        console.error("Failed to delete user:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    app.get("/api/dashboard/user/:userId", async (req, res) => {
      try {
        const { userId } = req.params;
        const userObjectId = ObjectId.isValid(userId) ? new ObjectId(userId) : null;

        const booksRead = await deliveriesCollection.countDocuments({
          $or: [{ userId: userId }, { userId: userObjectId }],
          status: { $in: ["Delivered", "Returned"] }
        });

        const pendingDeliveries = await deliveriesCollection.countDocuments({
          $or: [{ userId: userId }, { userId: userObjectId }],
          status: "Pending"
        });

        const spentResult = await deliveriesCollection.aggregate([
          { $match: { $or: [{ userId: userId }, { userId: userObjectId }] } },
          { $group: { _id: null, totalSpent: { $sum: "$deliveryFee" } } }
        ]).toArray();
        const totalSpent = spentResult[0]?.totalSpent || 0;

        const readingChart = await deliveriesCollection.aggregate([
          { $match: { $or: [{ userId: userId }, { userId: userObjectId }], status: "Delivered" } },
          { $group: { _id: { $month: "$requestDate" }, count: { $sum: 1 } } },
          { $sort: { "_id": 1 } },
          { $project: { month: "$_id", count: 1, _id: 0 } }
        ]).toArray();

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

    app.get("/api/dashboard/user/:userId/deliveries", async (req, res) => {
      try {
        const { userId } = req.params;
        const userObjectId = ObjectId.isValid(userId) ? new ObjectId(userId) : null;

        const deliveries = await deliveriesCollection.find({
          $or: [{ userId: userId }, { userId: userObjectId }]
        }).sort({ requestDate: -1 }).toArray();

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

    app.get("/api/dashboard/user/:userId/reviews", async (req, res) => {
      try {
        const { userId } = req.params;
        const userObjectId = ObjectId.isValid(userId) ? new ObjectId(userId) : null;

        const reviews = await reviewsCollection.find({
          $or: [{ userId: userId }, { userId: userObjectId }]
        }).sort({ createdAt: -1 }).toArray();

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

    app.put("/api/dashboard/user/:userId/reviews/:reviewId", verifyToken, async (req, res) => {
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

    app.delete("/api/dashboard/user/:userId/reviews/:reviewId", verifyToken, async (req, res) => {
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

    app.post("/api/deliveries", (req, res, next) => {
      if (req.headers["x-internal-secret"] === process.env.INTERNAL_SECRET) return next();
      return verifyToken(req, res, next);
    }, async (req, res) => {
      try {
        const { userId, userEmail, bookId, deliveryFee } = req.body;
        if (!userId || !bookId) return res.status(400).send({ message: "userId and bookId are required" });

        const bookOid = ObjectId.isValid(bookId) ? new ObjectId(bookId) : null;
        if (!bookOid) return res.status(400).send({ message: "Invalid bookId" });

        const book = await addBooksCollection.findOne({ _id: bookOid });
        if (!book) return res.status(404).send({ message: "Book not found" });

        // Prevent duplicate delivery for same user+book that is still pending/dispatched
        const existing = await deliveriesCollection.findOne({
          userId,
          bookId,
          status: { $in: ["Pending", "Dispatched"] },
        });
        if (existing) return res.status(409).send({ success: true, message: "Delivery already exists", insertedId: existing._id });

        const delivery = {
          userId,
          userEmail,
          bookId,
          librarianEmail: book.librarianEmail,
          deliveryFee: Number(deliveryFee) || Number(book.deliveryFee) || 0,
          status: "Pending",
          requestDate: new Date(),
        };

        const result = await deliveriesCollection.insertOne(delivery);
        res.status(201).send({ success: true, insertedId: result.insertedId });
      } catch (error) {
        console.error("Failed to create delivery:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    app.get("/api/deliveries", verifyToken, verifyLibrarian, async (req, res) => {
      try {
        const { librarianEmail } = req.query;

        let deliveries;
        if (librarianEmail) {
          const librarianBooks = await addBooksCollection
            .find({ librarianEmail }, { projection: { _id: 1 } })
            .toArray();
          const bookIds = librarianBooks.map((b) => String(b._id));

          deliveries = await deliveriesCollection
            .find({
              $or: [
                { librarianEmail },
                { bookId: { $in: bookIds } },
              ],
            })
            .sort({ requestDate: -1 })
            .toArray();
        } else {
          deliveries = await deliveriesCollection.find().sort({ requestDate: -1 }).toArray();
        }

        const results = await Promise.all(deliveries.map(async (d) => {
          let book = null;
          try {
            const bookOid = ObjectId.isValid(d.bookId) ? new ObjectId(d.bookId) : null;
            if (bookOid) book = await addBooksCollection.findOne({ _id: bookOid });
          } catch { /* ignore */ }

          let user = null;
          try {
            const userOid = ObjectId.isValid(d.userId) ? new ObjectId(d.userId) : null;
            const orQuery = [{ id: d.userId }, ...(userOid ? [{ _id: userOid }] : [])];
            user = await betterAuthUsersCollection.findOne({ $or: orQuery });
            if (!user) user = await usersCollection.findOne({ $or: orQuery });
          } catch { /* ignore */ }

          return {
            ...d,
            bookTitle: book?.title || d.bookTitle || "Unknown Book",
            clientName: user?.name || d.userName || "Unknown",
            clientEmail: user?.email || d.userEmail || "",
          };
        }));

        res.send(results);
      } catch (error) {
        console.error("Failed to fetch deliveries:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    app.get("/api/deliveries/check", async (req, res) => {
      try {
        const { userId, userEmail, bookId } = req.query;
        if (!bookId || (!userId && !userEmail)) return res.json({ exists: false });

        const orClauses = [];
        if (userId) orClauses.push({ userId, bookId });
        if (userEmail) orClauses.push({ userEmail, bookId });

        const existing = await deliveriesCollection.findOne({
          $or: orClauses,
          status: { $in: ["Pending", "Dispatched"] },
        });

        res.json({ exists: !!existing });
      } catch {
        res.json({ exists: false });
      }
    });

    app.patch("/api/deliveries/:id", verifyToken, verifyLibrarian, async (req, res) => {
      try {
        const { status } = req.body;
        const result = await deliveriesCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status } }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Internal server error" });
      }
    });

    app.get("/api/dashboard/librarian/:librarianEmail/stats", verifyToken, verifyLibrarian, async (req, res) => {
      try {
        const { librarianEmail } = req.params;
        const totalBooks = await addBooksCollection.countDocuments({ librarianEmail });
        const pendingRequests = await deliveriesCollection.countDocuments({ librarianEmail, status: "Pending" });
        const earningsResult = await deliveriesCollection.aggregate([
          { $match: { librarianEmail } },
          { $group: { _id: null, total: { $sum: "$deliveryFee" } } }
        ]).toArray();
        const totalEarnings = earningsResult[0]?.total || 0;

        const mostRequested = await deliveriesCollection.aggregate([
          { $match: { librarianEmail } },
          { $group: { _id: "$bookId", requests: { $sum: 1 } } },
          { $sort: { requests: -1 } },
          { $limit: 3 }
        ]).toArray();

        const booksWithTitles = await Promise.all(mostRequested.map(async (item) => {
          const book = await addBooksCollection.findOne({ _id: new ObjectId(item._id) }).catch(() => null);
          return { title: book?.title || "Unknown", requests: item.requests };
        }));

        res.send({ totalBooks, pendingRequests, totalEarnings, mostRequested: booksWithTitles });
      } catch (error) {
        res.status(500).send({ message: "Internal server error" });
      }
    });

    app.get("/api/users", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const authUsers = await betterAuthUsersCollection.find().toArray();
        const customUsers = await usersCollection.find().toArray();

        const normalised = authUsers.map((u) => ({
          _id: u._id,
          id: u.id || String(u._id),
          name: u.name,
          email: u.email,
          role: u.role || "user",
          joinDate: u.createdAt,
        }));

        const authEmails = new Set(normalised.map((u) => u.email));
        const extras = customUsers
          .filter((u) => !authEmails.has(u.email))
          .map((u) => ({ ...u, joinDate: u.joinDate || u.createdAt }));

        res.send([...normalised, ...extras]);
      } catch (error) {
        console.error("Failed to fetch users:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    app.post("/api/users", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { name, email, role, password } = req.body;
        
        if (!name || !email || !role) {
          return res.status(400).send({ message: "Name, email and role are required" });
        }

        if (role === "admin") {
          return res.status(400).send({ message: "Cannot create admin role from here" });
        }

        const newUser = {
          name,
          email,
          role,
          password: password || "defaultpassword",
          createdAt: new Date().toISOString(),
        };

        const result = await usersCollection.insertOne(newUser);
        res.send({ success: true, insertedId: result.insertedId, ...newUser });
      } catch (error) {
        console.error("Failed to create user:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    app.patch("/api/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { role } = req.body;

        let result;
        if (ObjectId.isValid(id)) {
          result = await betterAuthUsersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } }
          );
        }
        if (!result || result.matchedCount === 0) {
          result = await betterAuthUsersCollection.updateOne({ id }, { $set: { role } });
        }
        if (!result || result.matchedCount === 0) {
          if (ObjectId.isValid(id)) {
            result = await usersCollection.updateOne({ _id: new ObjectId(id) }, { $set: { role } });
          }
        }
        if (!result || result.matchedCount === 0) {
          result = await usersCollection.updateOne({ id }, { $set: { role } });
        }

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({ success: true, message: "Role updated successfully" });
      } catch (error) {
        console.error("Failed to update role:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    app.get("/api/transactions", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const deliveries = await deliveriesCollection.find().sort({ requestDate: -1 }).toArray();
        
        const results = await Promise.all(deliveries.map(async (delivery) => {
          const book = await addBooksCollection.findOne({ _id: new ObjectId(delivery.bookId) });
          const user = await usersCollection.findOne({ 
            $or: [{ _id: new ObjectId(delivery.userId) }, { id: delivery.userId }] 
          });
          const librarian = await usersCollection.findOne({ email: delivery.librarianEmail });
          return {
            _id: delivery._id,
            userEmail: user?.email || "Unknown",
            librarianEmail: delivery.librarianEmail || "Unknown",
            amount: delivery.deliveryFee || 0,
            date: delivery.requestDate || delivery.createdAt,
            bookTitle: book?.title || "Unknown Book"
          };
        }));

        res.send(results);
      } catch (error) {
        console.error("Failed to fetch transactions:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    app.patch("/api/books/publish/:id", verifyAdminOrInternal, async (req, res) => {
      const result = await addBooksCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: "Published" } }
      );
      res.send(result);
    });

    app.get("/api/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
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
