import crypto from "crypto";
import mongoose from "mongoose";
import { razorpay } from "../config/razorpayClient.js";
import Course from "../Model/course.js";
import User from "../Model/userSchema.js";
import Payment from "../Model/payment.js";
import Subscription from "../Model/subscription.js";
import Lesson from "../Model/lesson.js";
import Module from "../Model/module.js";
import transporter from "./transporter.js";

/* ---------------- Helper: Email ---------------- */
async function sendEnrollmentEmail({ student, course, subjectSuffix, messageLines = [], expiresAt = null }) {
  try {
    const expiryDateString = expiresAt ? new Date(expiresAt).toLocaleDateString("en-US") : "N/A";
    const htmlLines = `
      <p>Hello ${student.FirstName || student.email},</p>
      ${messageLines.map((l) => `<p>${l}</p>`).join("")}
      <p><b>Course:</b> ${course.title}</p>
      <p><b>Access Expires:</b> ${expiryDateString}</p>
    `;
    await transporter.sendMail({
      from: `"SathyaGomani Academy" <${process.env.EMAIL_USER}>`,
      to: student.email,
      subject: `${course.title} - ${subjectSuffix}`,
      html: htmlLines,
    });
  } catch (err) {
    console.error("sendEnrollmentEmail failed:", err);
  }
}

/* ---------------- 1) Initiate Payment ---------------- */
export const initiatePayment = async (req, res) => {
  try {
    const { type, paymentOption, plan_id } = req.body || {};
    const isSubscription =
      (typeof type === "string" && type.toLowerCase() === "subscription") ||
      (typeof paymentOption === "string" && paymentOption.toLowerCase() === "emi") ||
      !!plan_id;

    if (isSubscription) return createSubscription(req, res);
    return createOrder(req, res);
  } catch (err) {
    res.status(500).json({ message: err.message || "Internal Server Error" });
  }
};

/* ---------------- 2) One-time Order ---------------- */
export const createOrder = async (req, res) => {
  try {
    const { courseId } = req.body;
    const student = await User.findById(req.user.id);
    if (!courseId) return res.status(400).json({ message: "Course ID is required" });

    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ message: "Course not found" });

    const amountInPaise = Math.round(Number(course.price || 0) * 100);
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
    });

    await Subscription.create({
      student: student._id,
      course: course._id,
      type: "one-time",
      amount: Number(course.price),
      currency: "INR",
      razorpay_order_id: order.id,
      status: "pending",
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      courseTitle: course.title,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ---------------- 3) Verify One-time Payment ---------------- */
export const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, courseId } = req.body;
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(body).digest("hex");
    if (expectedSignature !== razorpay_signature) return res.status(400).json({ message: "Invalid signature" });

    const student = await User.findById(req.user.id);
    const course = await Course.findById(courseId);

    const durationInDays = course.durationInDays || 365;
    const isLifetime = durationInDays > 5000; 
    const expiresAt = isLifetime ? new Date("9999-12-31") : new Date(Date.now() + durationInDays * 24 * 60 * 60 * 1000);

    student.subscribedCourses.push({ courseId: course._id, subscribedAt: new Date(), expiresAt });
    await student.save();

    await Payment.create({ student: student._id, course: courseId, razorpay_order_id, razorpay_payment_id, amount: course.price });
    await Subscription.findOneAndUpdate({ razorpay_order_id }, { status: "active", expiresAt });

    await sendEnrollmentEmail({
      student, course,
      subjectSuffix: "Enrollment Confirmed",
      messageLines: ["Payment successful! Access granted."],
      expiresAt,
    });

    res.status(200).json({ message: "Payment successful!" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ---------------- 4) Create Subscription (EMI) ---------------- */
export const createSubscription = async (req, res) => {
  try {
    const { courseId, emiPlanId, total_count } = req.body;
    const course = await Course.findById(courseId);
    const student = await User.findById(req.user.id);

    const resolvedCount = Number(total_count || 6);
    const perInstallmentPaise = Math.round((course.price * 100) / resolvedCount);

    const plan = await razorpay.plans.create({
      period: "monthly", interval: 1,
      item: { name: `${course.title} - EMI`, amount: perInstallmentPaise, currency: "INR" }
    });

    const rzpSubscription = await razorpay.subscriptions.create({
      plan_id: plan.id,
      total_count: resolvedCount,
      customer_notify: 1,
    });

    await Subscription.create({
      student: student._id,
      course: course._id,
      type: "subscription",
      razorpay_subscription_id: rzpSubscription.id,
      status: "pending",
      total_count: resolvedCount,
      paid_count: 0
    });

    res.json({ subscriptionId: rzpSubscription.id, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ---------------- 5) Webhook ---------------- */
export const razorpayWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const raw = req.rawBody || req.body;
    const expectedSignature = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");

    if (expectedSignature !== signature) return res.status(400).json({ message: "Invalid signature" });

    const body = JSON.parse(raw.toString());
    if (body.event === "subscription.charged") {
      const subEntity = body.payload.subscription.entity;
      const paymentEntity = body.payload.payment.entity;

      const localSub = await Subscription.findOne({ razorpay_subscription_id: subEntity.id }).populate("course student");
      if (!localSub) return res.status(200).json({ status: "ignored" });

      localSub.paid_count += 1;
      let expiresAt = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

      if (localSub.paid_count >= localSub.total_count) {
        expiresAt = new Date("9999-12-31");
        localSub.status = "completed";
      }

      const student = await User.findById(localSub.student._id);
      const subIdx = student.subscribedCourses.findIndex(s => String(s.courseId) === String(localSub.course._id));
      if (subIdx >= 0) { student.subscribedCourses[subIdx].expiresAt = expiresAt; }
      else { student.subscribedCourses.push({ courseId: localSub.course._id, subscribedAt: new Date(), expiresAt }); }
      
      await student.save();
      await Payment.create({ student: student._id, course: localSub.course._id, razorpay_payment_id: paymentEntity.id, amount: paymentEntity.amount / 100 });
      
      localSub.expiresAt = expiresAt;
      await localSub.save();
    }
    res.status(200).json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ message: "Internal Error" });
  }
};

/* ---------------- 6) Utilities & History ---------------- */

export const getStudentPaymentHistory = async (req, res) => {
  try {
    const payments = await Payment.find({ student: req.user.id }).populate("course", "title thumbnail price").sort({ createdAt: -1 });
    res.status(200).json(payments);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Admin utility to get a specific student's history
export const getPaymentHistoryByStudent = async (req, res) => {
  try {
    const { studentId } = req.params;
    const payments = await Payment.find({ student: studentId }).populate("course", "title thumbnail").sort({ createdAt: -1 });
    res.status(200).json(payments);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getAllSubscriptions = async (req, res) => {
  try {
    const subs = await Subscription.find({}).populate("student", "FirstName LastName email").populate("course", "title price").sort({ createdAt: -1 });
    res.json(subs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getAllPayments = async (req, res) => {
  try {
    const payments = await Payment.find({}).populate("student", "FirstName LastName email").populate("course", "title").sort({ createdAt: -1 });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getSubscriptionStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("subscribedCourses.courseId", "title thumbnail");
    const now = new Date();
    const status = user.subscribedCourses.map(sub => ({
      courseTitle: sub.courseId?.title,
      status: new Date(sub.expiresAt) > now ? "Active" : "Expired",
      expiresAt: sub.expiresAt
    }));
    res.json(status);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const cancelSubscription = async (req, res) => {
  try {
    const sub = await Subscription.findById(req.params.id);
    if (sub.razorpay_subscription_id) await razorpay.subscriptions.cancel(sub.razorpay_subscription_id);
    sub.status = "cancelled";
    await sub.save();
    res.json({ message: "Cancelled" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};