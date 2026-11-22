plugins {
    id("com.android.application")
}

android {
    namespace = "ru.smolnikov.aviaresource"
    compileSdk = 36

    defaultConfig {
        applicationId = "ru.smolnikov.aviaresource"
        minSdk = 26
        targetSdk = 36
        versionCode = 35
        versionName = "0.2.33"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/webAssets"))
}

val syncWebAssets by tasks.registering(Copy::class) {
    val webRoot = rootProject.projectDir.parentFile
    from(webRoot.resolve("index.html"))
    from(webRoot.resolve("manifest.webmanifest"))
    from(webRoot.resolve("src")) { into("src") }
    from(webRoot.resolve("media")) { into("media") }
    into(layout.buildDirectory.dir("generated/webAssets"))
}

tasks.named("preBuild").configure {
    dependsOn(syncWebAssets)
}
