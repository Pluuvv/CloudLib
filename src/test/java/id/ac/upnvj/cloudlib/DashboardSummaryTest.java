package id.ac.upnvj.cloudlib;

import io.quarkus.test.junit.QuarkusTest;
import jakarta.transaction.Transactional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;

@QuarkusTest
public class DashboardSummaryTest {

    @BeforeEach
    @Transactional
    public void setupData() {
        VisitorLog.deleteAll();
        ComputerReservation.deleteAll();
        Computer.deleteAll();
        Loan.deleteAll();
        BookCopy.deleteAll();
        Book.deleteAll();
        Tenant.deleteAll();

        Tenant tenant = new Tenant();
        tenant.code = "upnvj";
        tenant.name = "Perpustakaan UPNVJ";
        tenant.persist();

        Book book = new Book();
        book.tenantId = tenant.id;
        book.title = "Buku Uji";
        book.persist();

        BookCopy copy1 = new BookCopy();
        copy1.tenantId = tenant.id;
        copy1.bookId = book.id;
        copy1.barcode = "BC-01";
        copy1.status = "AVAILABLE";
        copy1.persist();

        BookCopy copy2 = new BookCopy();
        copy2.tenantId = tenant.id;
        copy2.bookId = book.id;
        copy2.barcode = "BC-02";
        copy2.status = "UNAVAILABLE";
        copy2.persist();

        VisitorLog log = new VisitorLog();
        log.tenantId = tenant.id;
        log.memberRef = "member-001";
        log.checkInAt = java.time.Instant.now();
        log.persist();
    }

    @Test
    @DisplayName("Dashboard summary menghasilkan metrik ringkasan operasional yang akurat per tenant")
    public void testSummary() {
        given()
            .header("X-Tenant", "upnvj")
        .when()
            .get("/dashboard/summary")
        .then()
            .statusCode(200)
            .body("tenantCode", equalTo("upnvj"))
            .body("totalBooks", equalTo(1))
            .body("totalCopies", equalTo(2))
            .body("availableCopies", equalTo(1))
            .body("totalVisitors", equalTo(1));
    }
}
