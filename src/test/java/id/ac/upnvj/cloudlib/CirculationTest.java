package id.ac.upnvj.cloudlib;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;
import jakarta.inject.Inject;
import jakarta.persistence.EntityManager;
import jakarta.transaction.Transactional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;

@QuarkusTest
public class CirculationTest {

    @Inject
    EntityManager em;

    @BeforeEach
    @Transactional
    public void setupData() {
        Loan.deleteAll();
        BookCopy.deleteAll();
        Book.deleteAll();
        Tenant.deleteAll();

        Tenant tenant = new Tenant();
        tenant.code = "upnvj";
        tenant.name = "UPN Veteran Jakarta";
        tenant.persist();

        Book book = new Book();
        book.tenantId = tenant.id;
        book.title = "Cloud Computing Baseline";
        book.author = "Tim CloudLib";
        book.isbn = "978-0001";
        book.persist();

        BookCopy copy = new BookCopy();
        copy.tenantId = tenant.id;
        copy.bookId = book.id;
        copy.barcode = "BARCODE-001";
        copy.status = "AVAILABLE";
        copy.persist();
    }

    @Test
    @DisplayName("Peminjaman buku yang berstatus AVAILABLE harus berhasil (201 Created)")
    public void testBorrowSuccess() {
        given()
            .header("X-Tenant", "upnvj")
            .contentType(ContentType.JSON)
            .body(Map.of(
                "barcode", "BARCODE-001",
                "memberRef", "2410512136"
            ))
        .when()
            .post("/loans")
        .then()
            .statusCode(201)
            .body("loanId", notNullValue())
            .body("barcode", equalTo("BARCODE-001"))
            .body("memberRef", equalTo("2410512136"))
            .body("dueAt", notNullValue());
    }

    @Test
    @DisplayName("Peminjaman ganda (double borrow) pada eksemplar yang sama harus ditolak (409 Conflict - QS03)")
    public void testDoubleBorrowConflict() {
        // Peminjaman pertama: berhasil
        given()
            .header("X-Tenant", "upnvj")
            .contentType(ContentType.JSON)
            .body(Map.of(
                "barcode", "BARCODE-001",
                "memberRef", "2410512136"
            ))
        .when()
            .post("/loans")
        .then()
            .statusCode(201);

        // Peminjaman kedua pada eksemplar yang sama sebelum dikembalikan: harus 409 Conflict
        given()
            .header("X-Tenant", "upnvj")
            .contentType(ContentType.JSON)
            .body(Map.of(
                "barcode", "BARCODE-001",
                "memberRef", "2410512088"
            ))
        .when()
            .post("/loans")
        .then()
            .statusCode(409)
            .body("error", containsString("sedang"));
    }

    @Test
    @DisplayName("Pengembalian buku yang dipinjam harus berhasil dan status kembali AVAILABLE (200 OK)")
    public void testReturnSuccess() {
        // Pinjam terlebih dahulu
        given()
            .header("X-Tenant", "upnvj")
            .contentType(ContentType.JSON)
            .body(Map.of(
                "barcode", "BARCODE-001",
                "memberRef", "2410512136"
            ))
        .when()
            .post("/loans")
        .then()
            .statusCode(201);

        // Kembalikan buku
        given()
            .header("X-Tenant", "upnvj")
            .contentType(ContentType.JSON)
            .body(Map.of("barcode", "BARCODE-001"))
        .when()
            .post("/loans/return")
        .then()
            .statusCode(200)
            .body("status", equalTo("AVAILABLE"))
            .body("returnedAt", notNullValue());
    }

    @Test
    @DisplayName("Pengembalian ulang pada buku yang sudah kembali harus ditolak (409 Conflict)")
    public void testDoubleReturnConflict() {
        // Coba langsung kembalikan buku yang statusnya masih AVAILABLE
        given()
            .header("X-Tenant", "upnvj")
            .contentType(ContentType.JSON)
            .body(Map.of("barcode", "BARCODE-001"))
        .when()
            .post("/loans/return")
        .then()
            .statusCode(409)
            .body("error", containsString("tidak sedang dipinjam"));
    }
}
