plugins {
    id("com.android.application") version "8.2.0"
    id("org.jetbrains.kotlin.android") version "1.9.22"
}

val rawKVideoUrl = providers
    .gradleProperty("kvideoUrl")
    .orElse(providers.environmentVariable("KVIDEO_URL"))
    .orElse("")
    .get()

// 烘焙私网地址会让所有安装者默认连到构建者的内网主机——只在显式要求时允许
val isPrivateIpUrl = Regex(
    """^https?://(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)""",
    RegexOption.IGNORE_CASE
).containsMatchIn(rawKVideoUrl)
if (isPrivateIpUrl) {
    logger.warn(
        "WARNING: baking a private/LAN URL into DEFAULT_KVIDEO_URL ($rawKVideoUrl). " +
            "Every install will prefill this address. Pass -PkvideoUrl= only when that is intended."
    )
}

val defaultKVideoUrl = rawKVideoUrl
    .replace("\\", "\\\\")
    .replace("\"", "\\\"")

// 发布签名：未提供 keystore 时产出未签名 release APK（无法直接安装）。
// 构建签名包：
//   KVIDEO_KEYSTORE_FILE=/path/to/kvideo-release.jks \
//   KVIDEO_KEYSTORE_PASSWORD=... KVIDEO_KEY_ALIAS=kvideo KVIDEO_KEY_PASSWORD=... \
//   ./gradlew assembleRelease -PkvideoUrl=<服务器地址>
val releaseKeystorePath = providers
    .gradleProperty("kvideoKeystoreFile")
    .orElse(providers.environmentVariable("KVIDEO_KEYSTORE_FILE"))
    .orNull
val releaseKeystorePassword = providers
    .gradleProperty("kvideoKeystorePassword")
    .orElse(providers.environmentVariable("KVIDEO_KEYSTORE_PASSWORD"))
    .orNull
val releaseKeyAlias = providers
    .gradleProperty("kvideoKeyAlias")
    .orElse(providers.environmentVariable("KVIDEO_KEY_ALIAS"))
    .orNull
val releaseKeyPassword = providers
    .gradleProperty("kvideoKeyPassword")
    .orElse(providers.environmentVariable("KVIDEO_KEY_PASSWORD"))
    .orNull

android {
    namespace = "com.kvideo.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.kvideo.tv"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "1.1.0"

        buildConfigField("String", "DEFAULT_KVIDEO_URL", "\"$defaultKVideoUrl\"")
    }

    signingConfigs {
        if (releaseKeystorePath != null) {
            create("release") {
                storeFile = file(releaseKeystorePath)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.activity:activity-ktx:1.8.2")
    implementation("androidx.webkit:webkit:1.9.0")
}
