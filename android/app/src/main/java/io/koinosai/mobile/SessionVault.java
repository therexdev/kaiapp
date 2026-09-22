package io.koinosai.mobile;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Account credentials never fall back to plaintext, preferences, or Android backup. */
class SessionVault {
    private static final String ALIAS="kai-account-v1";
    private final AtomicFile file;
    SessionVault(Context context) {file=new AtomicFile(new File(context.getNoBackupFilesDir(),"account.enc"));}
    private SecretKey key() throws Exception {
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(store.containsAlias(ALIAS)) return (SecretKey)store.getKey(ALIAS,null);
        KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    JSONObject read() throws Exception {
        if(!file.getBaseFile().exists())return null;
        byte[] bytes;try(InputStream in=file.openRead()){bytes=ModelFile.readLimited(in,512*1024);}
        if(bytes.length<29)throw new IOException("Invalid saved session");
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,bytes,0,12));
        return new JSONObject(new String(cipher.doFinal(bytes,12,bytes.length-12),StandardCharsets.UTF_8));
    }
    void write(JSONObject value) throws Exception {
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());
        byte[] encrypted=cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
        FileOutputStream out=null;
        try {out=file.startWrite();out.write(cipher.getIV());out.write(encrypted);file.finishWrite(out);}
        catch(Exception e){if(out!=null)file.failWrite(out);throw e;}
    }
    void clear(){file.delete();}
}
