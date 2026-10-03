package io.koinosai.mobile;

import java.io.*;
import java.security.MessageDigest;
import java.util.function.BooleanSupplier;

final class ModelFile {
    static String verify(File file, long expectedSize, String expectedHash, BooleanSupplier cancelled) throws Exception {
        if (expectedSize > 0 && file.length() != expectedSize) throw new IOException("The model download is incomplete. Delete it and retry.");
        if (file.length() < 24) throw new IOException("This file is not a complete GGUF model.");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream stream = new BufferedInputStream(new FileInputStream(file))) {
            byte[] header = new byte[4];
            new DataInputStream(stream).readFully(header);
            if (header.length != 4 || header[0] != 'G' || header[1] != 'G' || header[2] != 'U' || header[3] != 'F')
                throw new IOException("Choose a GGUF model file. This file has a different format.");
            digest.update(header);
            byte[] buffer = new byte[1024 * 1024]; int read;
            while ((read = stream.read(buffer)) != -1) {
                if (cancelled.getAsBoolean()) throw new IOException("Stopped.");
                digest.update(buffer, 0, read);
            }
        }
        StringBuilder hash = new StringBuilder();
        for (byte b : digest.digest()) hash.append(String.format("%02x", b & 255));
        if (expectedHash != null && !expectedHash.isEmpty() && !expectedHash.equals(hash.toString()))
            throw new IOException("The model failed its integrity check. Delete it and download again.");
        return hash.toString();
    }

    static long copy(InputStream input, File destination, long maximumBytes, BooleanSupplier cancelled) throws IOException {
        long total = 0;
        try (OutputStream output = new BufferedOutputStream(new FileOutputStream(destination))) {
            byte[] buffer = new byte[1024 * 1024]; int read;
            while ((read = input.read(buffer)) != -1) {
                if (cancelled.getAsBoolean()) throw new IOException("Stopped.");
                total += read;
                if (total > maximumBytes) throw new IOException("This model is too large for the available storage or this device.");
                output.write(buffer, 0, read);
            }
        } catch (IOException e) { destination.delete(); throw e; }
        return total;
    }

    static byte[] readLimited(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream out=new ByteArrayOutputStream(); byte[] buffer=new byte[8192]; int count;
        while((count=input.read(buffer))!=-1) {
            if(out.size()+count>limit) throw new IOException("File is too large.");
            out.write(buffer,0,count);
        }
        return out.toByteArray();
    }
}
