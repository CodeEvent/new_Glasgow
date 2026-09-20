<?php
/**
 * The footer for this theme.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
	</div><!-- #content -->

	<footer id="colophon" class="site-footer">
		<div class="container">
			<div class="footer-grid">
				<div class="footer-brand">
					<div class="site-branding">
						<?php glasgow_bahai_emblem(); ?>
						<div>
							<p class="site-title"><?php bloginfo( 'name' ); ?></p>
							<span class="site-description"><?php echo esc_html_x( 'Baha\'i Community of Glasgow', 'footer tagline', 'glasgow-bahai' ); ?></span>
						</div>
					</div>
					<p><?php esc_html_e( 'A warm welcome to everyone in Glasgow interested in exploring spiritual and community life together — devotional gatherings, study circles, and activities for children and junior youth are open to all.', 'glasgow-bahai' ); ?></p>
				</div>

				<div class="footer-col">
					<h4 id="footer-nav-heading"><?php esc_html_e( 'Explore', 'glasgow-bahai' ); ?></h4>
					<nav aria-labelledby="footer-nav-heading">
						<?php
						wp_nav_menu( array(
							'theme_location' => 'footer',
							'container'      => false,
							'menu_class'     => '',
							'fallback_cb'    => 'glasgow_bahai_fallback_menu',
						) );
						?>
					</nav>
				</div>

				<div class="footer-col">
					<h4><?php esc_html_e( 'Get in Touch', 'glasgow-bahai' ); ?></h4>
					<ul>
						<li><a href="<?php echo esc_url( home_url( '/contact/' ) ); ?>"><?php esc_html_e( 'Contact us', 'glasgow-bahai' ); ?></a></li>
						<li><a href="https://www.bahai.org.uk" target="_blank" rel="noopener"><?php esc_html_e( 'Baha\'is of the UK', 'glasgow-bahai' ); ?></a></li>
						<li><a href="https://www.bahai.org" target="_blank" rel="noopener"><?php esc_html_e( 'Bahai.org', 'glasgow-bahai' ); ?></a></li>
					</ul>
				</div>
			</div>

			<div class="footer-bottom">
				<p>&copy; <?php echo esc_html( gmdate( 'Y' ) ); ?> <?php bloginfo( 'name' ); ?>. <?php esc_html_e( 'All are welcome.', 'glasgow-bahai' ); ?></p>
				<p><?php esc_html_e( 'Site built with WordPress.', 'glasgow-bahai' ); ?></p>
			</div>
		</div>
	</footer>
</div><!-- #page -->

<?php wp_footer(); ?>
</body>
</html>
