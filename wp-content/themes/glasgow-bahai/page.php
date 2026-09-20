<?php
/**
 * The template for displaying standard pages.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

get_header();
?>

<div class="page-hero">
	<div class="container">
		<h1><?php the_title(); ?></h1>
	</div>
</div>

<main id="primary" class="site-main">
	<?php
	while ( have_posts() ) :
		the_post();
		get_template_part( 'template-parts/content', 'page' );

		if ( is_page( 'contact' ) ) :
			?>
			<div class="content-wrap contact-form-wrap">
				<?php if ( isset( $_GET['contact'] ) ) : ?>
					<?php if ( 'success' === $_GET['contact'] ) : ?>
						<div class="form-notice form-notice--success" role="status">
							<?php esc_html_e( "Thank you — your message has been sent. We'll be in touch soon.", 'glasgow-bahai' ); ?>
						</div>
					<?php else : ?>
						<div class="form-notice form-notice--error" role="alert">
							<?php esc_html_e( 'Sorry, something went wrong sending your message. Please try again, or email us directly.', 'glasgow-bahai' ); ?>
						</div>
					<?php endif; ?>
				<?php endif; ?>

				<form class="contact-form" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<input type="hidden" name="action" value="glasgow_bahai_contact">
					<?php wp_nonce_field( 'glasgow_bahai_contact', 'glasgow_bahai_contact_nonce' ); ?>
					<p class="form-honeypot" aria-hidden="true">
						<label for="contact_website"><?php esc_html_e( 'Website', 'glasgow-bahai' ); ?></label>
						<input type="text" id="contact_website" name="glasgow_bahai_contact_website" tabindex="-1" autocomplete="off">
					</p>

					<p class="form-field">
						<label for="contact_name"><?php esc_html_e( 'Name', 'glasgow-bahai' ); ?></label>
						<input type="text" id="contact_name" name="contact_name" required>
					</p>
					<p class="form-field">
						<label for="contact_email"><?php esc_html_e( 'Email', 'glasgow-bahai' ); ?></label>
						<input type="email" id="contact_email" name="contact_email" required>
					</p>
					<p class="form-field">
						<label for="contact_message"><?php esc_html_e( 'Message', 'glasgow-bahai' ); ?></label>
						<textarea id="contact_message" name="contact_message" rows="5" required></textarea>
					</p>
					<p class="form-submit">
						<button type="submit" class="btn btn-solid"><?php esc_html_e( 'Send Message', 'glasgow-bahai' ); ?></button>
					</p>
				</form>
			</div>
			<?php
		endif;

		if ( comments_open() || get_comments_number() ) {
			comments_template();
		}
	endwhile;
	?>
</main>

<?php get_footer(); ?>
