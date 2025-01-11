const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function testS3() {
  try {
    const data = await s3Client.send(new ListBucketsCommand({}));
    console.log('Conexión exitosa. Buckets disponibles:', data.Buckets);
  } catch (err) {
    console.error('Error al conectar con AWS:', err.message);
  }
}

testS3();
