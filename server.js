require("dotenv").config();
const express = require("express");
const {
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const nodemailer = require("nodemailer");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const {
  ListObjectsV2Command,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
app.use(express.json());

// ✅ CORS Setup (added localhost entries for dev/testing)
app.use(
  cors({
    origin: [
      "http://student-bubble-frontend-1234.s3-website-us-east-1.amazonaws.com",
      "http://student-bubble-frontend-123.s3-website-us-east-1.amazonaws.com",
      // Local testing origins
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// =============================
//  AWS setup
// =============================
const REGION = "us-east-1";
const dynamoClient = new DynamoDBClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const uploadBucket = "student-bubble-uploads-123";

// ✅ Nodemailer setup
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "studentbubble00@gmail.com",
    pass: process.env.EMAIL_PASS || "nqcb htux srdp ajxj",
  },
});

// ✅ In-memory OTP store
const otpStore = {};

// ✅ Root route
app.get("/", (req, res) => {
  res.send(
    "✅ Student Bubble backend is running and connected to AWS DynamoDB + S3"
  );
});

// =============================
//  AUTH & OTP SECTION
// =============================

// Send OTP
app.post("/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email required" });

  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };

    await transporter.sendMail({
      from: "studentbubble00@gmail.com",
      to: email,
      subject: "Your Student Bubble OTP",
      text: `Your OTP is ${otp}. It is valid for 5 minutes.`,
    });

    console.log(`📧 OTP sent to ${email} (${otp})`);
    res.json({ message: "OTP sent successfully" });
  } catch (err) {
    console.error("Send OTP error:", err);
    res.status(500).json({ message: "Error sending OTP" });
  }
});

// Verify OTP
app.post("/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  const record = otpStore[email];
  if (!record) return res.status(400).json({ message: "No OTP found" });
  if (Date.now() > record.expiresAt)
    return res.status(400).json({ message: "OTP expired" });
  if (record.otp !== otp)
    return res.status(400).json({ message: "Invalid OTP" });

  delete otpStore[email];
  res.json({ message: "OTP verified successfully" });
});

// Signup
app.post("/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ message: "All fields required" });

  try {
    const hashed = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    await dynamoClient.send(
      new PutItemCommand({
        TableName: "Users",
        Item: {
          userId: { S: userId },
          name: { S: name },
          email: { S: email },
          password: { S: hashed },
          createdAt: { S: new Date().toISOString() },
        },
      })
    );

    const token = jwt.sign(
      { userId, email },
      process.env.JWT_SECRET || "secret123",
      { expiresIn: "1h" }
    );

    res.json({ message: "Signup successful", token });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ message: "Error creating user" });
  }
});

// Login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const data = await dynamoClient.send(
      new ScanCommand({
        TableName: "Users",
        FilterExpression: "email = :e",
        ExpressionAttributeValues: { ":e": { S: email } },
      })
    );

    if (!data.Items || data.Items.length === 0)
      return res.status(400).json({ message: "User not found" });

    const user = data.Items[0];
    const valid = await bcrypt.compare(password, user.password.S);
    if (!valid) return res.status(400).json({ message: "Invalid password" });

    const token = jwt.sign(
      { userId: user.userId.S, email },
      process.env.JWT_SECRET || "secret123",
      { expiresIn: "1h" }
    );

    res.json({ message: "Login successful", token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Check session
app.get("/check-session", (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer "))
      return res.status(401).json({ message: "Missing or invalid token" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret123");
    res.json({ message: "Session valid", userId: decoded.userId });
  } catch (err) {
    res.status(401).json({ message: "Session invalid or expired" });
  }
});

// =============================
//  FILE UPLOADS
// =============================
const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload", upload.single("file"), async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ message: "No token" });

  const token = authHeader.split(" ")[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || "secret123");
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }

  if (!req.file) return res.status(400).json({ message: "No file uploaded" });

  try {
    const fileKey = `${decoded.userId}/${Date.now()}-${req.file.originalname}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: uploadBucket,
        Key: fileKey,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    const noteId = uuidv4();
    const fileUrl = `https://${uploadBucket}.s3.amazonaws.com/${fileKey}`;

    await dynamoClient.send(
      new PutItemCommand({
        TableName: "Notes",
        Item: {
          noteId: { S: noteId },
          userId: { S: decoded.userId },
          title: { S: req.file.originalname },
          fileKey: { S: fileKey },
          fileUrl: { S: fileUrl },
          createdAt: { S: new Date().toISOString() },
        },
      })
    );

    res.json({
      message: "Note uploaded & saved successfully",
      fileUrl,
      noteId,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ message: "File upload failed" });
  }
});

app.get("/list-uploads", async (req, res) => {
  try {
    const data = await s3.send(
      new ListObjectsV2Command({ Bucket: uploadBucket, MaxKeys: 100 })
    );
    // If you want public URLs and your bucket is not public, create presigned URLs:
    const items = (data.Contents || []).map((obj) => ({
      Key: obj.Key,
      Size: obj.Size,
      LastModified: obj.LastModified,
    }));
    res.json(items);
  } catch (err) {
    console.error("List uploads error:", err);
    res.status(500).json({ message: "Could not list uploads" });
  }
});

// =============================
//  NOTES APIs
// =============================
app.post("/save-note", async (req, res) => {
  const { userId, title, content } = req.body;
  if (!userId || !title || !content)
    return res.status(400).json({ message: "Missing fields" });

  try {
    await dynamoClient.send(
      new PutItemCommand({
        TableName: "Notes",
        Item: {
          noteId: { S: uuidv4() },
          userId: { S: userId },
          title: { S: title },
          content: { S: content },
          createdAt: { S: new Date().toISOString() },
        },
      })
    );
    res.json({ message: "Note saved successfully" });
  } catch (err) {
    console.error("Save note error:", err);
    res.status(500).json({ message: "Error saving note" });
  }
});

app.get("/get-notes", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer "))
      return res.status(401).json({ message: "No token" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret123");

    const data = await dynamoClient.send(
      new ScanCommand({
        TableName: "Notes",
        FilterExpression: "userId = :uid",
        ExpressionAttributeValues: { ":uid": { S: decoded.userId } },
      })
    );

    const notes = (data.Items || []).map((n) => ({
      noteId: n.noteId.S,
      userId: n.userId.S,
      title: n.title?.S,
      content: n.content?.S || null,
      fileUrl: n.fileUrl?.S || null,
      createdAt: n.createdAt.S,
    }));

    res.json(notes);
  } catch (err) {
    console.error("Get notes error:", err);
    res.status(500).json({ message: "Error fetching notes" });
  }
});

// =============================
//  ASSIGNMENTS & REMINDERS
// =============================
app.post("/save-assignment", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ message: "No token" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret123");
    const { course, title, dueDate, reminderTime } = req.body;
    const assignmentId = uuidv4();

    await dynamoClient.send(
      new PutItemCommand({
        TableName: "Assignments",
        Item: {
          assignmentId: { S: assignmentId },
          userId: { S: decoded.userId },
          course: { S: course },
          title: { S: title },
          dueDate: { S: dueDate },
          reminderTime: { S: reminderTime || "" },
          status: { S: "Pending" },
          createdAt: { S: new Date().toISOString() },
        },
      })
    );

    await transporter.sendMail({
      from: "studentbubble00@gmail.com",
      to: decoded.email,
      subject: `Assignment Added: ${title}`,
      text: `Your assignment "${title}" for ${course} was added successfully.\nReminder: ${
        reminderTime || "None"
      }`,
    });

    // Schedule reminder
    if (reminderTime) {
      const delay = new Date(reminderTime).getTime() - Date.now();
      if (delay > 0) {
        setTimeout(async () => {
          try {
            await transporter.sendMail({
              from: "studentbubble00@gmail.com",
              to: decoded.email,
              subject: `Reminder: ${title} due soon!`,
              text: `Reminder: Your assignment "${title}" for ${course} is due on ${dueDate}.`,
            });
            console.log(`📧 Reminder email sent for ${title}`);
          } catch (mailErr) {
            console.error("Reminder email failed:", mailErr);
          }
        }, delay);
      }
    }

    res.json({ message: "Assignment saved successfully", assignmentId });
  } catch (err) {
    console.error("Save assignment error:", err);
    res.status(401).json({ message: "Invalid token" });
  }
});

app.get("/get-assignments", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ message: "No token" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret123");
    const data = await dynamoClient.send(
      new ScanCommand({
        TableName: "Assignments",
        FilterExpression: "userId = :uid",
        ExpressionAttributeValues: { ":uid": { S: decoded.userId } },
      })
    );

    const clean = (data.Items || []).map((i) => ({
      assignmentId: i.assignmentId.S,
      course: i.course.S,
      title: i.title.S,
      dueDate: i.dueDate.S,
      reminderTime: i.reminderTime.S,
      status: i.status.S,
    }));

    res.json(clean);
  } catch (err) {
    console.error("Get assignments error:", err);
    res.status(401).json({ message: "Invalid token" });
  }
});

// =============================
//  TO-DO LIST SECTION
// =============================

// Add new todo
app.post("/add-todo", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer "))
      return res.status(401).json({ message: "No token" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret123");

    const { name, dueDate, importance } = req.body;
    const userId = decoded.userId;
    const todoId = uuidv4();

    await dynamoClient.send(
      new PutItemCommand({
        TableName: "Todos",
        Item: {
          todoId: { S: todoId },
          userId: { S: userId },
          name: { S: name },
          dueDate: { S: dueDate },
          importance: { S: importance },
          completed: { BOOL: false },
          createdAt: { S: new Date().toISOString() },
        },
      })
    );

    res.json({
      message: "Todo added successfully",
      todo: { todoId, name, dueDate, importance, completed: false },
    });
  } catch (err) {
    console.error("Add Todo Error:", err);
    res.status(500).json({ message: "Error adding todo" });
  }
});

// Get all todos for user
app.get("/get-todos", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer "))
      return res.status(401).json({ message: "No token" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret123");
    const userId = decoded.userId;

    const data = await dynamoClient.send(
      new ScanCommand({
        TableName: "Todos",
        FilterExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": { S: userId } },
      })
    );

    const todos = (data.Items || []).map((t) => ({
      todoId: t.todoId.S,
      name: t.name.S,
      dueDate: t.dueDate.S,
      importance: t.importance.S,
      completed: t.completed?.BOOL || false,
    }));
    res.json(todos);
  } catch (err) {
    console.error("Get Todos Error:", err);
    res.status(500).json({ message: "Error fetching todos" });
  }
});

// Update todo completion
app.put("/update-todo/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { completed } = req.body;

    await dynamoClient.send(
      new UpdateItemCommand({
        TableName: "Todos",
        Key: { todoId: { S: id } },
        UpdateExpression: "SET completed = :c",
        ExpressionAttributeValues: { ":c": { BOOL: completed } },
      })
    );

    res.json({ message: "Todo updated" });
  } catch (err) {
    console.error("Update Todo Error:", err);
    res.status(500).json({ message: "Error updating todo" });
  }
});

// Delete todo
app.delete("/delete-todo/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await dynamoClient.send(
      new DeleteItemCommand({
        TableName: "Todos",
        Key: { todoId: { S: id } },
      })
    );
    res.json({ message: "Todo deleted successfully" });
  } catch (err) {
    console.error("Delete Todo Error:", err);
    res.status(500).json({ message: "Error deleting todo" });
  }
});

// =============================
//  START SERVER
// =============================
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Student Bubble backend running on port ${PORT}`);
});
