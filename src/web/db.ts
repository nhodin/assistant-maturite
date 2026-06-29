/** Single PrismaClient instance for the web app. */
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
