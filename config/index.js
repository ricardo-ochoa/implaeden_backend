// config/index.js
import path from 'path';
import dotenv from 'dotenv';

// Selecciona .env según NODE_ENV (por defecto development)
const env = process.env.NODE_ENV || 'development';
dotenv.config({ path: path.resolve(process.cwd(), `.env.${env}`) });

export default {
  env,
  port: process.env.PORT,

  db: {
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT),
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  },

  aws: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region:          process.env.AWS_REGION,
    s3Bucket:        process.env.S3_BUCKET_NAME,
  },

  email: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },

  jwt: {
    secret: process.env.JWT_SECRET,
  },

  cors: {
    origins: process.env.CORS_ORIGINS.split(','),
  },
};
