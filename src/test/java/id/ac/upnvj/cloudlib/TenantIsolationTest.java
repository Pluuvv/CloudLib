package id.ac.upnvj.cloudlib;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;
import jakarta.transaction.Transactional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;

@QuarkusTest
public class TenantIsolationTest {

    @BeforeEach
    @Transactional
    public void setupMultiTenantData() {
        Loan.deleteAll();
        BookCopy.deleteAll();
        Book.deleteAll();
        Tenant.deleteAll();

        // Tenant A: UPN Veteran Jakarta
        Tenant tenantA = new Tenant();
        tenantA.code = "upnvj";
        tenantA.name = "Perpustakaan UPNVJ";
        tenantA.persist();

        Book bookA = new Book();
        bookA.tenantId = tenantA.id;
        bookA.title = "Buku Rahasia Tenant A";
        bookA.author = "Penulis A";
        bookA.isbn = "ISBN-AAA";
        bookA.persist();

        BookCopy copyA = new BookCopy();
        copyA.tenantId = tenantA.id;
        copyA.bookId = bookA.id;
        copyA.barcode = "BARCODE-A-01";
        copyA.status = "AVAILABLE";
        copyA.persist();

        // Tenant B: Kampus Mitra
        Tenant tenantB = new Tenant();
        tenantB.code = "poltek";
        tenantB.name = "Perpustakaan Poltek";
        tenantB.persist();

        Book bookB = new Book();
        bookB.tenantId = tenantB.id;
        bookB.title = "Buku Khusus Tenant B";
        bookB.author = "Penulis B";
        bookB.isbn = "ISBN-BBB";
        bookB.persist();

        BookCopy copyB = new BookCopy();
        copyB.tenantId = tenantB.id;
        copyB.bookId = bookB.id;
        copyB.barcode = "BARCODE-B-01";
        copyB.status = "AVAILABLE";
        copyB.persist();
    }

    @Test
    @DisplayName("Uji Negatif Isolasi QS09: Tenant B tidak boleh dapat meminjam eksemplar milik Tenant A (404 Not Found)")
    public void testCrossTenantBorrowForbidden() {
        given()
            .header("X-Tenant", "poltek") // Header milik Tenant B
            .contentType(ContentType.JSON)
            .body(Map.of(
                "barcode", "BARCODE-A-01", // Barcode milik Tenant A!
                "memberRef", "NIM-POLTEK-99"
            ))
        .when()
            .post("/loans")
        .then()
            .statusCode(404)
            .body("error", containsString("tidak ditemukan pada tenant ini"));
    }

    @Test
    @DisplayName("Uji Isolasi QS09: Katalog buku yang dikueri Tenant B tidak boleh menampilkan buku milik Tenant A")
    public void testCrossTenantCatalogIsolation() {
        given()
            .header("X-Tenant", "poltek") // Query katalog sebagai Tenant B
        .when()
            .get("/books")
        .then()
            .statusCode(200)
            .body("size()", equalTo(1))
            .body("[0].title", equalTo("Buku Khusus Tenant B"))
            .body("title", not(hasItem("Buku Rahasia Tenant A"))); // Pastikan buku Tenant A terisolasi penuh
    }

    @Test
    @DisplayName("Permintaan tanpa header X-Tenant atau tenant tidak valid harus ditolak (400 Bad Request)")
    public void testMissingOrInvalidTenantHeader() {
        given()
            .header("X-Tenant", "nonexistent-tenant")
        .when()
            .get("/books")
        .then()
            .statusCode(400)
            .body("error", containsString("tenant tidak dikenal"));
    }
}
